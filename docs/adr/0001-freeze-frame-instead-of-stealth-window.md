# フリーズフレーム方式の採用（ステルスウィンドウ化の不採用） / Freeze frame instead of stealth window

元の設計ドキュメント（Gemini調査PDF）は、領域選択オーバーレイの自己写り込みを防ぐために `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` によるステルスウィンドウ化を中核技術として挙げている。AuraCapはこれを採用せず、ホットキー押下の瞬間に先に全画面をキャプチャし、その静止画上で領域選択させる「フリーズフレーム方式」を採る。自己写り込みが原理的に発生せず、選択中に画面内容が動いてズレる問題も消え、ピクセル拡大鏡の実装も静止画に対して行えるため単純になる。

The original design document (Gemini research PDF) treats stealth-window APIs (`SetWindowDisplayAffinity` with `WDA_EXCLUDEFROMCAPTURE`) as a core technique to prevent the selection overlay from appearing in captures. AuraCap instead captures the full screen first on hotkey press and lets the user select a region on that frozen image. Self-capture becomes structurally impossible, screen content cannot shift during selection, and the pixel magnifier operates on a static image.

## Consequences

- 静止画キャプチャには十分だが、動画録画機能を将来追加する場合はライブオーバーレイが必要になるため、その時点でステルス化APIを導入して本判断を再検討する。 / Sufficient for still capture; if video recording is added later, a live overlay will be required and stealth APIs should be introduced — revisit this decision then.
- マルチモニターでは全モニターを同時に凍結するが、矩形選択は1モニター内に制限する（DPI混在環境での座標・解像度の整合問題をv0.1では回避するため）。 / All monitors freeze simultaneously, but a selection rectangle is confined to a single monitor (avoids mixed-DPI coordinate/resolution reconciliation in v0.1).
