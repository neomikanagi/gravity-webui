# フレンドと私信

上部「フレンド」は公式フレンド名簿を読みます（フォロー名簿は別枠にしません。フォロー／フォローバックは自動同期）。続き読み込みができます。ニックネームか「メッセージ」でチャットを開きます。新しい私信はどのページでも上部に差出人、件数、最後の一文を出します（名刺はメッセージ自身の `user.name`）。タップでそのチャットを開きます。タブタイトルに未読数、フレンドタブと名簿行に赤点。「未読」は未読の人だけ見ます。部屋の一般メンバーやマイク席の人も名前を押して連絡できます。部屋／投稿／フレンドの切替では、元の試聴接続を止めません。

私信は最大500字。送信ボタンか Ctrl/⌘+Enter のときだけ出します。画像は「画像」ボタン（jpg/png/gif ≤1MB：先に公式 `newUploadV2`（`source=private`）で審査アップロードし、ネイティブ type 25（`detail` が `{url,width,height}` の base64）で同じ IM 接続から出します。文字と同じく1秒1件／1分20件と提出番号の重複排除）。失敗時はいまの相手の下書きを残します。同じ提出番号はサーバープロセス内で1時間残し、結果不明では自動再送しません。履歴は直近30件と今回接続のキャッシュ、1チャット最大100件。履歴の `CustomMsgContent` type 25 は、base64 した `detail`（ネイティブ、`lc/c.a`）か `extInfo`／`extra` から公式 CDN（gif 含む）を出します。音声やグループチャットは送りません。相手ブロック（bizCode 11009）では相手を自動ブロックします。フレンドからのボイスルームカード（type 44、`detail` が `MessageVoiceRoomV4{channel_id,name,label_info,room_type}`）はワンタップ入室／試聴カードになります（入室前に入室不要プレビューでホスト ID を補います）。文字の公式共有リンク（`shareVoiceRoomOnline`／短縮）も同じワンタップ入室です。

## 接続とフィルタ

- ページが前面で、サーバーに IM 接続が無い（idle）ときは、同源確認 POST で自動接続します（1分に最大1回）。他端末に押し出された（kicked）あとは手動再接続だけ。バックグラウンド GET ポーリングはログインを奪い返しません。前面ページの状態ポーリングは `keep=1` で接続を保ちます。ページを閉じる、またはバックグラウンド約10分ポーリングが無いとサーバーが接続を放し、App が再び受け取れます。Web が接続を使っているあいだ、同じアカウントの App にはリアルタイム私信が届かず、App 未読も Web に同期しません。
- 公式 UID `1000000000`、`[1000001000,1000002000)`、`1000002002/1000002003`、公式アシスタント RC ID `989907610` をフィルタします。名簿、履歴、リアルタイム、送信先の全部です。いまのアカウントの 1:1 だけ受け、グループ、SERVICE/GROUP 名刺、システム通知は捨てます。判定は App の `D9.s/D9.f/D9.l` で、ニックネームキーワードでは人を消しません。ネイティブ ChatAid（type 98）と `isAi`/`showAi`/`aiAssistantInfo`/`platoMsgType` 付きの非文字カードは捨て、「App で見てください」も出しません。
- プッシュのプロトコル確認は、フィルタしても送ります。受信確認であり、返信・既読・外発ではありません。ReadMsgs は呼びません。
- アカウントトークン指紋の変化／セッションファイル消失で、古い IM、メッセージ、下書き資格、提出記録、送信許可を閉じます。公式 HTTP 読みはキューから出すとき expectedIdentity を照合し、送信の前後でもアカウントを照合します。
- `/api/im/send` はチャットを開いたあとの現在アカウント／宛先 permit、明示確認、提出番号が必要です。同源 Origin ＋ JSON ＋ `X-Gravity-Action: im-control`。サーバーは1秒1件、1分20件。任意の上流プロキシやブラウザ可読 IM トークンはありません。

## 実装

本番は純 Node で、Java/unidbg には依存しません。`gravity-maf.cjs` は固定公式ゲートウェイの私有 TCP。`gravity-imcore.cjs` はネイティブ IM セッション。`gravity-im-message.cjs` はメッセージと公式 UID。`gravity-im.cjs` はアカウント隔離のサービス層。`static/im-ui.js` は独立フロント。

出典：App `libhichannel-jni.so` と `com.gclub.im.frame.pb`、`com.gclub.imc`、`com.hiclub.android.im`。`gravity-maf-keys.json` は App 内蔵の公開プロトコル鍵表であり、ユーザー資格ではありません。

- 固定ゲートウェイは App `C2972j.t`。フレームは `HiV2 | u32 BE bodyLen | u32 flags | u32 LE tail` の16バイト頭。flags 下位4ビットが型、bit4 バージョン、bit8 暗号化、bit9 圧縮、bits10–13 ゼロ埋め長。
- 型：S1=1、S2=2、クライアントアプリ=5、サーバーアプリ=6、ping=7、channel=8。握手は内蔵 AES-256-ECB 鍵と secp112r2 ECDH。共有 x を右ゼロ埋めで AES-128 セッション鍵。アプリデータは AES-ECB(zlib(payload))。
- セッション：RegApp → Heartbeat → Login → sessionId 付き Heartbeat。最後を欠くと SESSION_OFFLINE。Heartbeat のサーバー時刻を送信オフセットに使います。
- UpPacket：sessionId=1、service=2、method=3、seq=4、uid=5、appId=6、bua=7、sys=8、biz=9。DownPacket の biz=6。応答 packetType=2、通知=3。channelCode=200、bizCode=0 が成功。
- IMPlusMsg/Send の OneMsg 1対1 type=1、from=2、to=4、seq=5、content=6。文字は MsgContent field 4。本文は CustomMsgContent JSON：文字 type=0、画像 type=25（`extInfo`／`extra` の url、または https content）。チャット ID は文字列順 `<small>:<large>`。64ビット UID、seq、clientMsgId は文字列のまま。画像は `cdn.gravity.place` HTTPS（gif 含む）だけ投影します。
