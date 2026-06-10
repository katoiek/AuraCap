# オーバーレイウィンドウの常駐・使い回し / Resident, reusable overlay windows

オーバーレイをキャプチャ毎に生成するとWebView2の初期化に毎回400〜500msかかり、体感の切り替え速度を支配していた。AuraCapは起動時にモニター毎のオーバーレイウィンドウを事前生成して隠したまま常駐させ、セッション開始はイベント通知（`session-start`）と凍結画像の差し替え（メモリ上の無圧縮BMPを`freeze://`カスタムプロトコルで配信）だけで行う。これによりセッション配信は約130〜190msになった。代償として、非表示のWebViewがモニター数ぶん常駐しRAMを消費する（「軽量常駐」コンセプトとのトレードオフを速度優先で解決）。

Creating overlays per capture cost 400–500ms of WebView2 initialization each time, dominating perceived latency. AuraCap pre-creates one hidden overlay window per monitor at startup and reuses them: a session is started by an event (`session-start`) plus swapping the frozen frame (uncompressed BMP served from memory via the `freeze://` custom protocol). Session dispatch now takes ~130–190ms. The cost is resident hidden WebViews consuming RAM per monitor (speed was chosen over the "lightweight resident" ideal).

## Consequences

- 白フラッシュ防止のため、オーバーレイは凍結画像のロード完了通知（`overlay_ready`）まで表示されない。フロントエンドが応答しない場合は2.5秒後に強制表示する保険がある。 / To avoid the white flash, overlays stay hidden until the frontend reports the frozen image loaded (`overlay_ready`); a 2.5s fallback force-shows them if the frontend never responds.
- モニター構成の変化はセッション開始時に検出し、不足分のウィンドウを都度生成・位置補正する。 / Monitor layout changes are handled at session start by creating missing windows and re-syncing positions.
- フロントエンドのオーバーレイは使い回されるため、状態リセットは`session-start`/`session-end`イベント駆動で行う必要がある。 / Because the frontend overlay is reused, its state must be reset via the `session-start`/`session-end` events.
