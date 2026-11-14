# Review và kế hoạch cải thiện benchmark Axiom + ms

Ngày review: 2026-11-14. Phạm vi: `ab_axiom_uc01.ts`, `ab_axiom_uc01_results.json`, `AB_AXIOM_REPORT.md`; đối chiếu adapter, runtime và source Axiom đang có trên máy. Đây là kế hoạch, chưa thay đổi harness hoặc chạy lại model.

## Kết luận từ dữ liệu hiện có

- Các tổng trong JSON khớp với sáu run và bảng số liệu trong report. Hai arm đều vượt qua kiểm tra bug mục tiêu ở 3/3 case.
- Trong lần đo này, B có thời gian 74.460/34.477 = **2,16 lần**, 31/19 lượt LLM và 43/24 tool call. Đây là kết quả mô tả của ba cặp run, mỗi case một lần.
- Chi phí ghi nhận là $0,092053/$0,044064 = **2,09 lần**, nhưng cách định giá bên dưới có lỗi; chưa dùng các số USD này làm cơ sở quyết định.
- Chưa có đủ bằng chứng để kết luận nguyên nhân chậm là schema/hashline, hoặc distilled output giúp case 02 nhanh hơn. Cần trace và thí nghiệm tách từng yếu tố.

## Findings theo mức ưu tiên

### F1 · P1 · Chi phí dùng sai pricing key và sai hợp đồng cache token

**Vị trí:** `ab_axiom_uc01.ts:27,639-643`; `AB_AXIOM_REPORT.md:23-29`; dependency `/home/hoang/nhom-30/src/llm/cost-tracker.ts:16,127-138` và `src/llm/providers/anthropic.ts:438-448`.

Harness dùng `claude-haiku-5-5`, nhưng bảng giá local có key `claude-haiku-5.5`; lookup ID đang dùng trả về fallback `{input:2, output:8, cacheRead:0.5}`. Provider chuyển `input_tokens` vào `promptTokens` và giữ cache-read riêng, trong khi calculator giả định cache đã nằm trong prompt và chặn `cached <= prompt`. Với các số hiện có, cache-read lớn hơn rất nhiều so với input; phần lớn cache không tham gia tính giá. Cache creation có trong provider usage nhưng không được tổng hợp vào kết quả benchmark.

**Đã kiểm chứng offline:** `calculateCost('claude-haiku-5-5', 100, 10, 1000)` và cùng lệnh với cache `100000` đều trả về `0.00013`; lookup trả bảng giá fallback. Đây là lỗi hợp đồng dữ liệu và định giá local, chưa phải xác nhận giá thương mại của model.

**Ảnh hưởng:** số USD và budget gate kế thừa cùng nguồn lỗi. Không thể khôi phục chi phí chính xác của run cũ chỉ bằng JSON tổng hợp vì thiếu raw usage theo request, cache creation và pricing snapshot.

### F2 · P1 · PASS chỉ chứng minh vài assertion, bỏ qua regression và lỗi suite

**Vị trí:** `ab_axiom_uc01.ts:437-525`; `ab_axiom_uc01_results.json:43-47,89-93`; `AB_AXIOM_REPORT.md:18`.

Case 01 chỉ lấy exit code CLI/unit; case 03 chỉ lấy exit code unit. Pytest được chạy nhưng không ảnh hưởng PASS của hai case này. Fixture vốn đã có lỗi search không liên quan, nên không thể sửa bằng cách bắt mọi case phải có `pytestExitCode === 0`. Harness cần biết lỗi nào đã tồn tại và hành vi lành nào phải được giữ.

**Đã kiểm chứng bằng chính hàm verifier trích từ harness, trên bản sao tạm:**

1. Cả ba case trên fixture gốc đều bị từ chối đúng.
2. Sửa tối thiểu `format_tags` cho case 01 được PASS dù pytest còn lỗi search có sẵn.
3. Thêm `Store.search = None` vẫn PASS, mặc dù search giờ hỏng cả trường hợp từng hoạt động.
4. Cho test phát sinh lỗi collection mới, pytest exit 2, verifier vẫn PASS.

Các phản ví dụ cho thấy oracle có điểm mù; chúng không chứng minh sáu patch đã đo thực sự gây regression. Chưa lưu patch nên hiện cũng không thể audit lại điều đó.

### F3 · P1 · Hai arm thay đổi cả cơ chế thực thi và phạm vi bảo vệ

**Vị trí:** `ab_axiom_uc01.ts:312-341,553-569`; `AB_AXIOM_REPORT.md:12,55`; `examples/axiom_adapter.ts:635-661`; `crates/ms-rpc/src/exec.rs:109-137`.

Baseline `BashTool` dùng `/bin/bash`, scrub environment, chọn backend theo cấu hình sandbox và mặc định timeout 120 giây. Baseline `run_tests` dùng verifier có kiểm tra target, argv riêng và cơ chế sandbox/local opt-in. B thay bằng `ms exec`: shell `sh` theo heuristic, process kế thừa environment, `python3 -m pytest` trực tiếp và timeout CLI mặc định 60 giây. Do đó đây là phép so sánh hai gói tích hợp có nhiều khác biệt, chưa tách được hiệu quả distillation/hashline.

Registry vẫn chạy permission policy, nhưng `allowWithoutApprover: true` tự cho qua nhánh cần hỏi. `openat2` và WAL áp dụng cho thao tác file qua RPC; lệnh shell trong `ms exec` có thể ghi file mà không đi qua WAL/test guard của edit tool. Câu “All mutations” trong report vượt quá bảo đảm của đường thực thi hiện tại. Benchmark cũng không có thử nghiệm crash recovery, stale revision hoặc undo để chứng minh các bảo đảm ấy.

### F4 · P1 · Lỗi giữa chừng có thể làm mất kết quả của các run đã tốn tiền

**Vị trí:** `ab_axiom_uc01.ts:646-651,661-665,702-709`.

Mỗi `runSingle` được await trực tiếp; exception setup/verifier có thể dừng toàn bộ batch. Kết quả chỉ ghi cuối batch vào một filename cố định. `finally` xóa workspace và session, trong khi JSON chỉ giữ thống kê và danh sách file từ agent. Không có patch, transcript hay checkpoint để giải thích vòng lặp thêm của B, kiểm tra sửa bằng shell, hoặc phục hồi phần batch đã hoàn tất.

### F5 · P2 · Một lượt/case, luôn A trước B, không có provenance đầy đủ

**Vị trí:** `ab_axiom_uc01.ts:19-28,662-694`; `AB_AXIOM_REPORT.md:49-50`.

Ba cặp run không đo được run-to-run variance. Thứ tự cố định có thể lẫn hiệu ứng thời gian, backend cache và warm-up; hiện chưa định lượng được hướng hoặc mức ảnh hưởng. Report viện dẫn một run trước khi sửa adapter nhưng không kèm artifact, và so sánh hai phiên bản harness không kiểm soát được biến số.

Paths và dependency sibling hard-code; payload thiếu commit/dirty hash của hai repo, binary hash, fixture hash, tool definitions, prompt hash, generation settings và cấu hình execution. File JSON không đủ để tái tạo lần đo.

### F6 · P2 · Telemetry chưa trả lời được vì sao B dùng thêm lượt

**Vị trí:** `ab_axiom_uc01.ts:35-39,572-585,620-644`; `AB_AXIOM_REPORT.md:45-54`.

`durationMs` được thu nhưng không xuất ra artifact; không có timeline, kích thước tool output, request usage hay output LLM theo lượt. `toolFailures` chỉ đếm `isError` của registry. Nonzero exit của một command hoặc pytest fail dự kiến có thể là tool invocation thành công ở cả hai arm; “0 tool failures” không đồng nghĩa mọi command/test đều thành công. B vẫn hiển thị exit trong header, nhưng wrapper bỏ structured `exitCode`, nên thiếu dữ liệu để phân loại riêng.

Ngoài ra `filesChanged` là danh sách active files Axiom theo dõi cho edit/write/apply_patch, không phải diff filesystem; thay đổi qua shell hoặc undo có thể không được phản ánh đúng. Report cũng đếm fixture là 7 file trong khi hiện có 8 file nếu tính README và test; cần ghi rõ quy ước đếm.

## Kế hoạch triển khai

Thứ tự: độ đúng của oracle và kế toán → lưu bằng chứng → thiết kế phép đo → tối ưu theo bằng chứng. Các thay đổi ở dependency Axiom cần đi cùng phiên bản được pin; chỉ sửa ba file benchmark sẽ không giải quyết hết F1/F3.

### Bước 1 · Sửa nền tảng đo trước khi gọi model tiếp

- [ ] Chuẩn hóa usage ở ranh giới provider: `uncachedInput`, `cacheRead`, `cacheWrite` và `output`, không trừ cache lần hai. Chọn một hợp đồng chung rõ ràng cho các provider.
- [ ] Resolve pricing theo model ID chuẩn; unknown price phải được đánh dấu hoặc chặn chế độ đo cost, không âm thầm dùng fallback. Ghi nguồn, ngày, đơn giá và đây là estimated cost hay charge thực tế. Cache-write cần phân biệt loại nếu đơn giá khác nhau.
- [ ] Bổ sung oracle bất biến bên ngoài workspace agent: kiểm tra bug mục tiêu trước/sau, healthy invariants và kết quả suite theo node ID. Cho phép lỗi search đã biết ở case 01/03 nhưng từ chối lỗi collection, test mất/skip mới, timeout và regression trên hành vi từng đúng.
- [ ] Kiểm tra thêm hành vi lành mà test gốc chưa phủ: search đúng case, add/save/reload, tags có sẵn và bảng không rỗng với nhiều hàng. Giữ các test/spec được bảo vệ; phân biệt test mới do agent thêm với test gốc bị sửa.
- [ ] Tách `targetFixed`, `noRegressions`, `verificationComplete`, `agentStatus`; chỉ gọi overall PASS khi thỏa các điều kiện đã định nghĩa. Timeout/error có loại kết quả riêng, không bị biến thành pass hoặc mất khỏi mẫu.
- [ ] Dùng cùng policy execution, môi trường đã scrub, shell, Python, timeout, target validation và backend sandbox cho thí nghiệm so sánh có kiểm soát. Nếu cần giữ tích hợp nguyên bản để đánh giá sản phẩm, công bố rõ mọi khác biệt.

**Điều kiện hoàn tất:** các fixture lỗi chưa sửa bị FAIL; patch đúng được PASS; hai phản ví dụ ở F2 bị từ chối; thay đổi cache-read làm estimated cost thay đổi với đơn giá dương; lookup model không rơi fallback; hai arm có cùng execution policy trong phép đo có kiểm soát. Test các điều này offline bằng dữ liệu giả lập, không dùng mock để tuyên bố agent sửa được bug thật.

### Bước 2 · Lưu artifact và phục hồi batch

- [ ] Tách entry point khỏi module để import/test verifier, wrappers và aggregation mà không tự gọi API. Thêm cấu hình đường dẫn CLI/env với default theo repo, preflight binary/dependency/fixture và một lệnh chạy được ghi rõ.
- [ ] Thêm `schemaVersion`, `experimentId`, `runId`, `trial`, thứ tự arm và config snapshot đã loại secrets. Ghi commit/dirty hash, hash binary/fixture/adapter, model resolved, tool/prompt hash và generation settings.
- [ ] Append JSONL sau mỗi run; checkpoint an toàn, resume theo run ID và không ghi đè lịch sử. Bắt exception theo từng run, lưu infra error và thống kê phần đã hoàn tất trước khi quyết định tiếp tục/dừng.
- [ ] Lưu trace đã redact theo tool call ID, request usage/pricing, tool output bytes, command exit/timeout, thời lượng setup/agent/verification/cleanup riêng. Dùng đồng hồ monotonic cho duration.
- [ ] Lưu patch/diff thực của mọi file, test-integrity check và kết quả verifier trước cleanup. Thư mục artifact nằm ngoài workspace agent và có giới hạn dung lượng rõ ràng.
- [ ] Sinh summary/report từ artifact; validate schema, tổng số run, denominator, tổng counters và link bằng chứng. Giữ JSON cũ như snapshot lịch sử, gắn trạng thái kế toán cũ chưa đáng tin.

**Điều kiện hoàn tất:** ngắt batch sau một run rồi resume không chạy trùng; exception của một run vẫn có record; mọi hàng report dẫn được đến trace/patch; sửa qua shell vẫn xuất hiện trong diff; không lưu credentials hoặc environment thô.

### Bước 3 · Thiết kế phép so sánh có thể diễn giải

- [ ] Giữ UC01 ba case làm smoke test. Chạy pilot tối thiểu **10 paired trials/case** với model thật sau khi bước 1–2 đạt; đây là điểm bắt đầu để ước lượng variance, chưa phải bảo đảm đủ statistical power.
- [ ] Cân bằng AB/BA và shuffle case bằng seed đã ghi; workspace/session/state mới cho từng run. Ghi cache usage và warm-up thực tế, không mặc định đã reset cache phía provider.
- [ ] Tách hai câu hỏi: “gói B hiện tại so với Axiom stock” và “thành phần nào của ms tạo khác biệt”. Với câu hỏi thứ hai, cố định execution policy và capability/schema có thể giữ chung; sau đó thay từng yếu tố: raw/distilled command output, plain/hashline read, tool set tối thiểu/đầy đủ.
- [ ] So sánh các ablation với cùng baseline và cùng bộ case, không gộp số từ harness cũ. Ghi mọi khác biệt schema/capability không thể giữ chung, gồm việc bỏ `apply_patch`.
- [ ] Báo paired delta theo case, median và khoảng tin cậy bootstrap theo cặp; raw samples vẫn đi kèm. Không dùng p95 từ 10 mẫu như ước lượng ổn định. Chọn số trial tiếp theo từ variance pilot và hiệu ứng cần phát hiện.
- [ ] Tách target fix rate, regression rate, infra error rate, cost mỗi attempted task và cost mỗi verified success; giữ cả run fail/timeout trong denominator phù hợp.

**Điều kiện hoàn tất:** report nêu rõ số case, số trial, order seed, policy và bất định; mọi kết luận nhân quả có ablation hỗ trợ. Nếu khoảng tin cậy còn rộng thì kết luận chưa đủ dữ liệu.

### Bước 4 · Tối ưu ms theo bottleneck đã đo

| Ưu tiên | Thay đổi cần thử | Bằng chứng để giữ thay đổi |
|---|---|---|
| 1 | Tool set tối thiểu cho tác vụ nhỏ; đánh giá bỏ schema outline/context/undo ít dùng | Giảm tool-definition tokens hoặc cost/turns qua paired trials, giữ chất lượng sửa lỗi |
| 2 | Output gọn hơn: bỏ lặp metadata, giới hạn context snippet, tóm tắt test nhất quán | Tool-output bytes/tokens giảm; không tăng reread, retry hoặc sai patch |
| 3 | Chế độ read/edit phù hợp kích thước file; so sánh plain với hashline | Thắng trên workload liên quan; khi dùng line-range edit vẫn có guard chống stale revision/tag |
| 4 | Hướng dẫn verification chung, ngắn và nhất quán cho hai arm | Giảm các lệnh kiểm tra trùng được trace xác nhận, không giảm số lỗi verifier phát hiện |
| 5 | Outline/context cho repo vừa/lớn, log dài, tìm symbol và stale-edit recovery | Bộ case mới có oracle và baseline; giảm context/cost hoặc tăng recovery success |

Không mặc định áp dụng “file nhỏ thì bỏ hashline” hoặc cắt tool chỉ từ ba sample này. Những cơ chế an toàn cần được giữ bằng giao thức edit thích hợp và test riêng, thay vì đổi lấy số token đẹp hơn.

**Tiêu chí ra quyết định đề xuất:** không chấp nhận regression mới trên bộ kiểm chứng; chọn cost/verified success làm chỉ số chính khi đã sửa kế toán, latency là chỉ số bổ sung. Chốt mức cải thiện thực dụng trước batch đánh giá cuối; nếu chọn mục tiêu 10% thì cần khoảng tin cậy đủ hẹp để phân biệt mức đó. Dành một tập case chưa dùng để tune cho lần xác nhận cuối.

## Chỉnh report khi triển khai

1. Gắn nhãn kết quả hiện tại là pilot một trial/case; USD là estimated cost từ tracker có lỗi đã xác nhận.
2. Đổi “Pass Rate” thành “Target checks passed”, bổ sung baseline suite failures và phạm vi kiểm tra regression thực tế.
3. Đổi “Where ms Helped/Hurt” thành quan sát và giả thuyết; single-run case 02 chưa chứng minh lợi ích của distillation.
4. Đổi “zero tool failures” thành “zero registry-level invocation errors”; trình bày command/test outcomes riêng khi đã có telemetry.
5. Giới hạn mô tả WAL/openat2/revision/test guard vào đúng đường file RPC; ghi unattended policy và execution backend.
6. Loại so sánh run trước khỏi bằng chứng chính cho đến khi có artifact và config tương ứng. Phần performance dùng số sinh tự động; phần diễn giải do người review kiểm tra.

## Kiểm tra đã thực hiện trong review

- Đối chiếu tổng JSON với từng run, số tool theo tên và các tỷ lệ thời gian/chi phí: đạt.
- Chạy lookup pricing và phản ví dụ cache trên `CostTracker` local: tái hiện lỗi F1.
- Chạy hàm `verifyWorkspace` thực được transpile từ harness trên bản sao tạm: xác nhận từ chối ba fixture lỗi gốc và tái hiện hai điểm mù F2.
- Đọc đường execution của cả hai arm để xác định khác biệt F3. Không chạy benchmark model, không dùng thêm token API và không sửa ba artifact gốc trong lượt review này.
