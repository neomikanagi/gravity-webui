# プロフィール、投稿、返信、ルームギフト

フレンドと部屋の人は同じプロフィール浮き窓です。公開名刺、国の略号、紹介、相手の投稿。右上「×」で閉じ、メッセージかブロックができます。国は資料 `user_country` の2文字 ISO（JP/CN/TW など）で、都市や登録地ではなく、インストール帰属 `getOrigin`（organic など）でもありません。上部「投稿」はおすすめ、フォロー中、新着、文字返信、いいね。切替やプロフィール閲覧では RTC/RTM を止めません。

## 投稿 API

- 固定署名の読み：`recommendFeedListV2`、`palFeedListV3`、`newFeedListV2`、`getFeedById`、`listCommentV3`。表示は `r_feed` だけで、サーバー HTML は実行しません。公開作者 ID は正確な文字列。画像は公式 HTTPS CDN だけ。
- `/api/feed/detail` は15分 permit。いまのセッション、投稿作者、このページのコメント作者に結び、ページ送り後の古いコメントも対応 permit を残します。送信前に投稿がコメント開放かと作者を再確認。キューから出すときトークン指紋を照合し、アカウント変化では外に出しません。
- `addCommentEncrypt` で投稿へ返信：サーバーが `to_user_id` を作る。`addCommentReplyEncrypt` でコメントへ返信：`b_user_id` と `a_user_id`。ブラウザは宛先、端点、役割を指定できません。いまは文字 1〜500 字だけ。画像コメント、投稿作成、削除はありません。ルームチャットの画像は [ACCOUNT_RTC.md](ACCOUNT_RTC.md)。フレンド／私信は [IM_PROTOCOL.md](IM_PROTOCOL.md)。
- いいねはネイティブ暗号化 **POST** `gravity/feed/voteEncrypt`（`FeedVoteRequest`）：`id`、`vote=1|0`、`to_user_id`、`type=f`、`feed_type`（おすすめ `feed8` / フォロー `feed6` / 新着 `feed5`）、`route_path`。投影は `is_vote` / `vote_count`。ブラウザ `/api/feed/collect` はこのページが読んだ投稿へのいいねだけで、收藏ではない。收藏は別の **GET** `gravity/feed/collect`（`CollectFeedRequest`）で、誤收藏の掃除にだけ使う。同じアカウント＋提出番号は1時間重複排除。予検失敗は再試行可、不明結果は自動再送しない。検証済みの「部屋をいいね」API はない。Web が投稿を読み込むとき自動いいね（`static/auto-like.js`）。サーバー tick もおすすめ投稿をいいねし、ページを開いていなくても動く。Web の自動いいねは `auto:true`。サーバー tick と `tasks-state.json` の記録を共有（`liked` は自動いいね済み、`noLike` は Web で外した。各々直近5000件）。記録済みの投稿は自動いいねしない。日をまたいでも、更新しても同じ。間隔 2.4 秒（サーバーは2秒に1回の書き込み制限）。両方合わせて1日最大400。個人ページの投稿は自動いいねしない。
- ネイティブ `AbstractC3222e` / `HttpRequestEncryptJsonBody`：署名パラメータに独立 `secret_key`、AES-128-CBC／ゼロ埋め、鍵自身が IV。別の乱数 AES 鍵を公式公開鍵 RSA PKCS1 で暗号化し、外層 Base64 JSON。リクエストは `application/raw; charset=utf-8`。応答は独立 secret key で復号。plaintext debug や有料 API は使わない。

## 公開プロフィールと個人投稿

`gravity-profile.cjs` は署名 `user/detail?target_id=…` と `feed/personalFeedList`。名刺は公開 ID／ニックネーム／CDN アバター、紹介、国、性格、公開関係カウントだけ。誕生日、メール、ログイン、端末メタデータは転送しない。非表示や見えない資料は明確にエラーし、空投稿のふりをしない。個人リストは選んだ作者の `r_feed` だけ。ページ送りは `last_id` とネイティブ `accumulated_feed_cnt`、画面は1ページ10件。30秒タイムアウトは更新可。閉じると読みをキャンセルし、古い結果で新しい相手を上書きしない。プロフィールキャッシュは30秒、最大64人、いまのアカウントに結び、切替で空にする。浮き窓の「メッセージ」を押したときだけ IM に繋ぐ。

## ホストをブロックして静かに退室

赤いボタンは先にこちらのキャプチャを止め、このページのアカウント登録／席を掃除して RTC/RTM を離れ、それから同源 `POST /api/profile/block-host`。プロフィール浮き窓の「ブロック」は `POST /api/profile/block` で、いまの名刺ユーザーが対象。自分、公式アカウント、ホスト交代、アカウント変化は拒否。ブロック退室も通常退室も別れの言葉は送らない。退出中の未送信文字、ギフト自動お礼、遅れて来た承認は続けて送らない／着席しない。
