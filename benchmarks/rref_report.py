"""C_py vs R_ref summary: pass, $/trial, $/pass, two-proportion p.  python3 benchmarks/rref_report.py PRICE DIR...
PRICE: openai-codex (luna) or anthropic (haiku 5.5), $/M tokens below."""
import collections, glob, json, math, statistics as st, sys

PRICES = {'openai-codex': (0.1, 0.01, 0.0, 0.5), 'anthropic': (1.0, 0.1, 1.25, 5.0)}  # in, cacheRead, cacheWrite, out


def cost(u, p):
    unc = u['prompt'] - u['cacheRead'] - u.get('cacheWrite', 0) if p[2] else u['prompt'] - u['cacheRead']
    return (max(unc, 0) * p[0] + u['cacheRead'] * p[1] + u.get('cacheWrite', 0) * p[2] + u['completion'] * p[3]) / 1e6


def pval(p1, n1, p2, n2):
    pp = (p1 + p2) / (n1 + n2); se = math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2))
    return math.erfc(abs(p1 / n1 - p2 / n2) / se / math.sqrt(2)) if se else 1.0


def report(price, dirs):
    P = collections.defaultdict(lambda: collections.defaultdict(list)); C = collections.defaultdict(list); bad = collections.Counter()
    for d in dirs:
        for f in glob.glob(f'{d}/*/2026-*/*__*/result.json'):
            arm, task = f.split('/')[-4], f.split('/')[-2].split('__')[0]
            r = json.load(open(f)); e = r.get('exception_info')
            try:
                g = json.load(open(f.rsplit('/', 1)[0] + '/agent/result.json'))
            except OSError:
                g = None
            if (e and e.get('exception_type') != 'AgentTimeoutError') or not g or g['llmTurns'] == 0 or any('usage limit' in x[2] for x in g.get('retries', [])):
                bad[arm] += 1; continue  # infra/auth/quota: not the agent's result
            rw = ((r.get('verifier_result') or {}).get('rewards') or {}).get('reward')
            P[task][arm].append(rw == 1.0); C[arm].append(cost(g['usage'], PRICES[price]))
    arms = ('C_py', 'R_ref'); tot = {a: [0, 0] for a in arms}
    lines = [f"| task | {' | '.join(arms)} |", '|---|---|---|']
    for t in sorted(P):
        cells = []
        for a in arms:
            v = P[t][a]; tot[a][0] += sum(v); tot[a][1] += len(v); cells.append(f'{sum(v)}/{len(v)}' if v else '-')
        lines.append(f"| {t} | {' | '.join(cells)} |")
    for a in arms:
        p, n = tot[a]
        if n:
            lines.append(f'{a}: pass {p}/{n} = {100 * p / n:.0f}%, ${st.mean(C[a]):.4f}/trial, ${sum(C[a]) / max(p, 1):.4f}/pass')
    if all(tot[a][1] for a in arms):
        (p1, n1), (p2, n2) = tot['R_ref'], tot['C_py']
        lines.append(f'R_ref - C_py = {100 * (p1 / n1 - p2 / n2):+.1f} pts, p={pval(p1, n1, p2, n2):.2f}; excluded (infra/quota): {dict(bad)}')
    return '\n'.join(lines)


if __name__ == '__main__':
    if sys.argv[1:] == ['--selftest']:
        assert abs(pval(16, 30, 12, 30) - 0.30) < 0.02 and pval(0, 1, 0, 1) == 1.0
        assert cost({'prompt': 100, 'cacheRead': 40, 'completion': 10}, PRICES['openai-codex']) == (60 * 0.1 + 40 * 0.01 + 10 * 0.5) / 1e6
        print('selftest ok')
    else:
        for d in sys.argv[2:]:
            print(f'## {d}'); print(report(sys.argv[1], [d]))
