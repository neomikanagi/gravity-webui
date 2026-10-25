# iOS 署名

Node で既存 App のキャプチャと同じ署名を再現できます。Frida、実機中継、unidbg の修理は不要です。実装は `gravity-sign-ios.cjs`、オフライン検証は `tests/gravity-sign-ios.test.cjs`（合成資格）。

## バイナリ根拠

- `ExtensionNetworkAPI.framework`：`ExtensionNetworkEncrypt.sign(params:)`、入口 `0x85b8`。
- `0x869c` / `0x86a0`：`mov w9, #0xa04b` + `movk w9, #0x197, lsl #16`、除数 `0x0197a04b`（**26714187**）。`umulh` / `lsr` / `msub` でタイムスタンプ余り。
- `getTempString`：AES-128-CBC、PKCS#7 で内蔵定数を復号。定数は実装に集約。一時 `api_security` は接頭、余りの文字列、接尾。
- 署名列：キー名ソート、区切りなしで `key=value` を UTF-8 MD5。いまのキャプチャ欄は文字列と整数タイムスタンプ。文字列はそのまま、空も残す。
- `Alamofire.URLEncoding.queryComponents` は NSNumber 枝なので、すべての文字列を先に URL エンコードしてはいけない。
- `api_security` はダイジェストのあと外し、`uwd` / `idfa` はリクエストに残す。App 保存トークンはパーセントエスケープを含むので、署名前に自分でデコードしない。最後は `URLSearchParams` でクエリを作る。

## 検証

```bash
node --test tests/*.test.cjs
```

単体は合成資格と固定ダイジェスト。本物の欄はローカル `.session` だけ（リポジトリに入れない）。新しいセッションのあとに、古いキャプチャダイジェストで新しいトークン無効を判定しない。

`40025/40026` はセッション失効であり、署名エラーではありません。拒否状態はトークン指紋で残し、新しい App トークンで再検証します。

`getAgoraToken` の受信専用は `channel_id` ＋ プロトコル `role_type=0` で `uid/rtc_token/rtm_token`。RTC 宣言は入室可、配信不可。役割対応は [ACCOUNT_RTC.md](ACCOUNT_RTC.md)。
