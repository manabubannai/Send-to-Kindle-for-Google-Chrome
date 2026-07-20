# セットアップ手順（はじめての方向け）

ブラウザで読んでいる記事を、**画像つきの読みやすいEPUB**にして自分のKindleに送るChrome拡張です。
公式「Send to Kindle」拡張が画像崩れ・エラーで使えない問題を解決します。

- 所要時間: **約15分**（一度設定すれば、あとはボタン1つ）
- 費用: **無料**（Vercel無料枠 + 自分のGmail）
- 仕組み: 送信は **あなた自身のGmail** から行われます。他人のサーバーは経由しません。

> 各自が自分のGmail・自分のサーバーで完結するので、誰かに迷惑をかけたり、上限で止まったりしません。

---

## 用意するもの

- Google Chrome
- Googleアカウント（Gmail）
- Amazon / Kindle アカウント
- Vercelアカウント（無料・GitHubでログイン）

---

## Part 1. 拡張機能をインストール（約3分）

1. このページ右上の緑色の **「Code」▸ Download ZIP** をクリックして保存 → **解凍**します。
   （`send-to-kindle-main` というフォルダができます）
2. Chromeで `chrome://extensions` を開きます。
3. 右上の **「デベロッパー モード」** を **ON** にします。
4. 左上の **「パッケージ化されていない拡張機能を読み込む」** をクリック。
5. 手順1で解凍した **`send-to-kindle-main` フォルダ**（`manifest.json` が入っている方）を選択します。
6. ツールバーに拡張が追加されます（📌アイコンで固定しておくと便利）。

> 「すべてのサイトのデータを読み取り…」という警告が出ます。これは**記事の画像を取得して埋め込むため**だけに使います。データ収集や外部送信は一切ありません。

Kindleに送れるようにするには、続けてPart 2〜4を設定します。

---

## Part 2. 送信用リレーを用意（約5分）

あなた専用の送信窓口（リレー）を、Vercelの無料枠に置きます。

### 2-1. Gmailアプリパスワードを発行

1. [Googleアカウント → セキュリティ](https://myaccount.google.com/security) で **2段階認証** をON（既にONなら次へ）。
2. [アプリパスワード](https://myaccount.google.com/apppasswords) を開き、名前を「Send to Kindle」などにして **生成**。
3. 表示される **16桁の文字列**をコピー（スペースは詰めてOK）。これは後で使います。

> このパスワードは絶対に他人に教えないでください。Vercelの設定画面にだけ入力します。

### 2-2. Vercelにデプロイ（ボタン1つ）

下のボタンを押すと、リポジトリの複製・設定・デプロイまで誘導されます。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmanabubannai%2Fsend-to-kindle&root-directory=backend&project-name=send-to-kindle&repository-name=send-to-kindle&env=GMAIL_USER,GMAIL_APP_PASSWORD&envDescription=%E8%87%AA%E5%88%86%E3%81%AEGmail%E3%82%A2%E3%83%89%E3%83%AC%E3%82%B9%E3%81%A8%E3%82%A2%E3%83%97%E3%83%AA%E3%83%91%E3%82%B9%E3%83%AF%E3%83%BC%E3%83%89)

1. ボタンを押し、**GitHubでVercelにログイン**（初回のみアカウント作成）。
2. リポジトリ名はそのままで進みます（あなたのGitHubに複製されます）。
3. **環境変数（Environment Variables）** の入力を求められます:
   | Name | Value |
   |---|---|
   | `GMAIL_USER` | あなたのGmailアドレス（例 `you@gmail.com`） |
   | `GMAIL_APP_PASSWORD` | 2-1でコピーした16桁 |
4. **Deploy** を押す。1〜2分で完了します。
5. 完了画面、または **Project → Domains** に出る `https://○○○.vercel.app` を控えます。
   **これに `/api/send` を付けたもの**が、あなたのリレーURLです。
   例: `https://send-to-kindle-xxxx.vercel.app/api/send`

---

## Part 3. AmazonにあなたのGmailを登録（約2分）

Amazonは「許可した差出人」からのメールしかKindleに取り込みません。

1. Amazon → **アカウントサービス → コンテンツと端末の管理**（Manage Your Content and Devices）
2. **設定（Preferences）→ パーソナル・ドキュメント設定**
3. **承認済みEメールアドレス一覧（Approved Personal Document E-mail List）** に
   **あなたのGmailアドレス**（Part 2で使ったもの）を追加。

同じ画面に、あなたの **送信先Kindleアドレス**（`〜@kindle.com`）が書いてあります。次で使うので控えておきます。

---

## Part 4. 拡張に設定を入力（約1分）

1. Chromeツールバーの拡張アイコンを右クリック →「オプション」、または拡張ポップアップの **Options** を開きます。
2. 2項目を入力して **Save**:
   | 項目 | 入れる値 |
   |---|---|
   | Your Send-to-Kindle email | あなたの `〜@kindle.com`（Part 3で確認） |
   | Email relay endpoint URL | Part 2のリレーURL（`…/api/send`） |

---

## 使い方

1. Kindleで読みたい記事のページを開く。
2. **拡張アイコンをクリックするだけ** — その瞬間に送信が始まります（ポップアップはすぐ閉じてOK）。
3. 数十秒で、画像つきEPUBがKindleに届きます。

複数の記事をまとめて送るときは、タブを開いてアイコンをクリック…を繰り返すだけです。
送信は裏で並行して進み、**失敗があればデスクトップ通知と赤バッジ**で知らせます
（通知をクリックすると該当タブに移動）。ポップアップを開けば直近の送信履歴と結果を確認できます。
同じページを3分以内に再送しようとした場合や、未確認のエラーが残っている場合は
自動送信されず、ポップアップ内のボタンで明示的に送る形になります（誤送信防止）。

---

## うまくいかないとき

| 症状 | 対処 |
|---|---|
| Kindleに届かない | Part 3で **あなたのGmail** を承認済みリストに入れたか確認。迷惑メールに振り分けられていないかGmail送信済みも確認 |
| 「Set your Kindle email…」と出る | Part 4のOptionsが未入力。Kindleメール と リレーURL の両方を入れてSave |
| 「Server not configured」と出る | Vercelの環境変数 `GMAIL_USER` / `GMAIL_APP_PASSWORD` が未設定。設定後 **再デプロイ**（Vercel → Deployments → Redeploy） |
| Gmailアプリパスワードが作れない | 先に2段階認証をONにする必要があります |
| 「この記事は読み取れません」 | chrome:// やストアなど一部ページは対象外。通常の記事ページで試してください |
| 画像が枠だけになる（古い版） | 拡張のバージョンが **0.2.1 以上** か確認。古ければZIPを取り直してリロード |

---

## 注意事項

- **自動更新はありません。** 改良版が出たら、再度ZIPをダウンロードして `chrome://extensions` でリロードしてください。
- 取り込んだ記事は **自分のKindleで読むため** のものです。再配布はしないでください。
- これは個人が作った非公式ツールです。Amazon / Kindle とは無関係です。
