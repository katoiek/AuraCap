# AuraCap

AI搭載を見据えたWindows向け画面キャプチャツール。まず開発者自身が毎日使う軽量ツールとして作り、価値が実証できたら製品化する。
A screen capture tool for Windows with future AI capabilities. Built first as a daily-driver tool for its own developer, to be productized once its value is proven.

## Language

### キャプチャ / Capture

**キャプチャ / Capture**:
画面の一部または全体を静止画として取得する行為。v0.1は静止画のみ（動画は対象外）。
_Avoid_: スクショ（UI文言では使わない）, 録画

**キャプチャモード / Capture Mode**:
何を撮るかの選択。「領域選択」「ウィンドウ単位」「全画面（モニター単位）」の3種。
_Avoid_: 撮影タイプ

**フリーズフレーム / Freeze Frame**:
ホットキー押下の瞬間に先に全画面を取得し、その静止画上で領域を選択させる方式。自己写り込みが原理的に発生しない。
_Avoid_: ライブ選択, スナップショットオーバーレイ

**領域選択 / Region Selection**:
フリーズフレーム上をドラッグして矩形範囲を切り出す操作。
_Avoid_: 範囲指定, クロップ（編集時のトリミングと区別する）

### 編集・保存 / Editing & Saving

**軽量エディタ / Quick Editor**:
キャプチャ直後に即起動する小さな編集ウィンドウ。アノテーションと出力操作のみを担う。Snagit級のフルエディタは目指さない。
_Avoid_: フルエディタ, ビューア

**アノテーション / Annotation**:
画像への書き込み要素。v0.1は矩形枠・矢印・テキスト・モザイク・トリミング・番号バッジ・ハイライトの7種。
_Avoid_: マークアップ, 装飾

**番号バッジ / Number Badge**:
手順説明用の連番スタンプ（①②③）。将来のSOP機能の布石。
_Avoid_: ステップマーカー

**履歴 / History**:
キャプチャした瞬間に無条件で自動保存されるPNGの保管場所。上限枚数で自動ローテーションする。
_Avoid_: ライブラリ, アーカイブ

**出力 / Export**:
編集後の画像をユーザーの明示操作でクリップボードまたはファイルへ書き出すこと。履歴への自動保存とは区別する。
_Avoid_: 保存（履歴の自動保存と曖昧になるため単独では使わない）
