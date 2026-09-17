[English](README.md) | [한국어](README.ko.md) | **日本語** | [简体中文](README.zh-CN.md)

# pi-codex-memory

[OpenAI Codex](https://github.com/openai/codex/tree/5bf132cd527311eb61bbec46562e3890eb49df80/codex-rs/memories) のメモリ機能を移植した独立した pi 拡張です。コミット `5bf132cd527311eb61bbec46562e3890eb49df80` に固定されています。pi のセッション、モデルレジストリ、認証をそのまま使用し、Codex のインストールやアカウントは不要です。ホストとの差異と検証内容: [CODEX_PARITY.md](CODEX_PARITY.md)。

## インストール

Node >=22.13、pi >=0.85.1、Git が必要です。

公開されている拡張を pi でインストール:

```sh
pi install npm:pi-codex-memory
```

pi を再起動するか既存セッションで `/reload` を実行し、`/memories status` で拡張の状態を確認します。デフォルトでは現在の pi セッションモデルを使用するため、別途モデル設定は不要です。

既存の npm インストールを更新:

```sh
pi update npm:pi-codex-memory
```

更新後は pi を再読み込みしてください。ローカル開発では `pi install /path/to/pi-codex-memory` でチェックアウトをインストールします。固定された Codex 上流ソースは実行時に自動更新されません。

## 動作

- 条件を満たす永続ルートセッションは、最初のユーザーターンでバックグラウンドパイプラインをディスパッチします。一時セッションとサブエージェントセッションは対象外です。
- フェーズ 1 は最近アイドルになった対話セッションを選び、SQLite ジョブを取得し、アクティブブランチをサニタイズし、構造化抽出を要求して検証済みの結果を保存します。リース、並行数制限、リトライバックオフで重複作業を防ぎます。
- フェーズ 2 はメモリバージョンごとにグローバルジョブを 1 つ取得し、使用量/新しさで証拠を選び、ロールアウト要約と V1 生メモリを同期し、リソースを整理し、Git ワークスペースの diff を計算します。変更がなくアーティファクトが有効なら統合モデル呼び出しは行われません。
- 変更がある場合、隔離された pi SDK エージェントセッションが jail されたファイルツールでメモリを統合します。一般拡張、プロジェクト指示、シェル/ネットワークツール、再帰的委任は読み込まれません。SDK の圧縮とキャンセルは同じ pi モデル/認証経路を使います。これはツールレベルの封じ込めであり、Codex の OS サンドボックスではありません。
- 読み取り経路は上流の指示と上限付きメモリ要約を注入します。引用されたロールアウト ID は使用回数を更新します。専用の検索/ノートツールは任意で、固定された契約に従います。
- V1 と V2 は別々のルート/データベースを持ちます。二重書き込みは両パイプラインを独立にディスパッチします。準備状況の報告は V2 のしきい値と要約の有効性を示すだけで、アクティブバージョンは変更しません。

独立した効率プロファイル、FTS/ベクトルインデックス、QMD モデル、意味検索、カスタムコアスナップショット、日次デルタ蒸留予算はありません。

## 設定

`~/.pi/agent/memories.json` に保存されます:

```json
{
  "version": "v1",
  "dual_write": false,
  "enabled": true,
  "generate_memories": true,
  "use_memories": true,
  "dedicated_tools": false,
  "disable_on_external_context": false,
  "max_raw_memories_for_consolidation": 256,
  "max_unused_days": 30,
  "max_rollout_age_days": 10,
  "max_rollouts_per_startup": 2,
  "min_rollout_idle_hours": 6,
  "extract_model": null,
  "consolidation_model": null,
  "tool_result_token_budget": 1000,
  "extract_thinking": "low",
  "consolidation_thinking": "medium"
}
```

### バックグラウンドのトークンコスト削減

フェーズ 1 はロールアウト全体を読み直しますが、実際のセッションではロールアウトの約 70% がツール出力(ファイル読み取り、コマンド stdout)です。依存関係不要の手段が 2 つあります:

1. **安価なモデル** — `extract_model` / `consolidation_model`(上記)。これが圧倒的に最大の節約です。
2. **`tool_result_token_budget`**(ホスト追加機能、Codex にはない; デフォルト `1000`、`0` で無効)— 抽出前に各ツール結果をこのトークン数に制限し、先頭と末尾を保持します(エラーは 3 倍まで)。同一行の繰り返しは `[… same line ×N]` に畳まれ、同一結果の繰り返しは `[identical to tool result #N: <先頭行>]` に置き換わります(ツール行は `[tool name #N]` と番号付き)。ユーザーとアシスタントのテキストは決して変更されないため、抽出器は 1 つの大きなファイルダンプで会話の末尾を失うことなく会話全体を見られます。

モデル呼び出しなしで自分のセッションで測定:

```bash
node --experimental-strip-types --no-warnings scripts/bench-compaction.mjs [budget=1000] [maxSessions=40]
```

ローカルマシンでの例(5 セッション、レンダリング 745K トークン、当時の OpenRouter 表示価格):

| | レンダリングされたロールアウト | フェーズ 1 送信(150K 上限) | フェーズ 1 コスト |
|---|---|---|---|
| セッションモデル(`gpt-6-astra` / `claude-fable-5.1`、$10/$50 per M)、生 | 745K | 321K | $3.58 |
| 同モデル、budget 1000 | 485K (-35%) | 275K (-14%) | $3.12 |
| `deepseek/deepseek-v4.1-flash`($0.30/$1.20 per M)、生 | 745K | 321K | $0.105 |
| flash、budget 1000 | 485K | 275K | **$0.092(×39 安価)** |

Budget 500 はエラー以外のツール出力が短くなる代わりに、レンダリングされたロールアウトを約 47% 削減します。すでに 150K 上限を超えているセッションは安くならず、よりバランスの取れた入力になるだけです。他モデルと比較するには `BENCH_PRICES='{"name":{"in":..,"out":..}}'` を設定します。

**圧縮で節約できること・できないこと。** 節約はロールアウト内のツール出力の割合に制限されます: `≈ tool_share × (1 − 1/compression)`、圧縮後も 150K 上限を超えるセッションではゼロです。ファイル読み取りとコマンド出力が支配的なセッション(通常ツール出力 70–90%)は 30–60% 節約し、アシスタントのコードや貼り付けテキストが大半のセッション、またはツール出力がすでにライブで圧縮されているセッション(例: `rtk` 方式のシェルフィルタ)はほとんど節約になりません。これは想定どおりです: ライブフィルタは同じバイトをソースで一度削り、フェーズ 1 は各ロールアウトを一度しか読まないため、利得を増幅するターンごとの倍率がありません。

エンドツーエンド確認(`scripts/bench-pipeline.sh`、隔離ホームで実際のフェーズ 1 + フェーズ 2、同じ 2 セッションを取得、`gpt-6-astra`、thinking low): budget 0 → フェーズ 1 223K トークン、フェーズ 2 42K 入力 / 132K キャッシュ / 5.3K 出力; budget 1000 → フェーズ 1 225K、フェーズ 2 31K / 164K / 6.0K。大きなセッションがツール出力 10% で上限を超えたままだったため、フェーズ 1 の節約はありませんでした。代わりにモデル選択が支配的でした: 同じ実行を `deepseek-v4.1-flash` で行うと約 11 倍(thinking `max`)から 30–40 倍(thinking `low`)安価でした。

```bash
# 実際のモデル呼び出し、費用が発生; label extract_model consolidation_model extract_thinking consolidation_thinking budget [セッション用 provider/model]
scripts/bench-pipeline.sh G1 null null low low 1000 openai-codex/gpt-6-astra
```

すべてのパイプライン実行は `memories.log` に `phase1: … N tokens` と `phase2: usage requests=… input=… cacheRead=… output=…` を追記するため、通常使用後に自分の数値を確認できます。

モデルは `provider/model-id` 形式です。デフォルトでは両ステージとも現在の pi セッションモデル(`null`)を使い、明示的な設定はそのステージのみ上書きします。Codex が推奨するモデルは自動選択されません。明示的な設定は利用不可または未認証なら失敗し、リクエストエラーがモデル切り替えを引き起こすことはありません。`/memories status` は最後に選択された provider/model、`session-default` または `explicit`、抽出出力の強制方式を表示します。

### メモリモデルの選択

**バックグラウンドのメモリ抽出と統合には、低コストのモデルを明示的に選ぶことを推奨します。** 特に対話セッションが高価なモデルを使う場合です。これらのステージと SDK 圧縮は追加のモデルリクエストを発生させます。必要な JSON を安定して生成し、統合ファイルツールを扱えるモデルを選び、依存する前に結果を確認してください。

1. pi でプロバイダを設定・認証し、pi のモデルセレクタから正確な `provider/model-id` をコピーします。
2. `~/.pi/agent/memories.json`(Windows: `%USERPROFILE%\.pi\agent\memories.json`)を編集し、以下のフィールドの片方または両方を設定します。プレースホルダを登録済みモデル ID に置き換えてください。両ステージで同じモデルを使っても構いません。

```json
{
  "extract_model": "your-provider/your-lower-cost-model-id",
  "consolidation_model": "your-provider/your-lower-cost-model-id"
}
```

3. pi を再読み込みし、次のメモリ実行後に `/memories status` で選択されたモデルと検証モードを確認します。

そのステージで現在のセッションモデルを使うには、フィールドを `null` に戻します。既存の明示的設定はアップグレード時に保持されます。モデル選択は pi ホストの適応であり、固定された Codex メモリ処理ルールは変わりません。

検証済みの OpenAI Responses および Chat Completions リクエストは上流の strict JSON Schema を送ります。他のプロバイダはローカルスキーマ検証を使い、互換モードとして報告されます。すべての出力はローカルで検証されます。統合は通常の SDK アシスタント停止とアーティファクト検証で完了し、カスタム完了ツールやターン上限はありません。Codex アカウントのクォータ API は実装されていません。

`generate_memories: false` は新しいセッションを除外しますが、上流と同様に以前の対象セッションは引き続き処理される可能性があります。`use_memories: false` は要約注入とツール実行を無効にします。`enabled: false` はこのプロセスのパイプラインを無効化・キャンセルします。バージョンとツール登録の変更には再読み込みが必要です。

## コマンドとツール

`/memories [status|readiness [minimum]|run|force|on|off|generate on|off|use on|off|thread on|off|reset]`

`run` はクールダウンを尊重し、`force` はクールダウン/変更なしでも実行する明示的な pi の上書きです。`thread off` はそのセッションを除外し抽出結果を削除します。Reset には確認が必要で、実行中のジョブがあれば拒否されます。元の pi セッションファイルが reset で削除されることはありません。

`dedicated_tools: true`、`enabled: true`、`use_memories: true` の場合:

| ツール | 契約 |
|---|---|
| `memories_list` | 可視メモリファイル; デフォルト/最大 2,000 件 |
| `memories_search` | 構造化マッチング、ウィンドウ、ページング; デフォルト/最大 200 件 |
| `memories_read` | UTF-8 ファイル、行オフセットと制限; デフォルト 20,000 参照トークン |
| `memories_add_ad_hoc_note` | 後の統合のための明示的なタイムスタンプ付きノート |

要約注入は上流の 2,500 トークン予算に従います。検索は埋め込みモデルを呼び出しません。

## データとマイグレーション

V1: `~/.pi/agent/memories/`、`memories_1.sqlite`。V2: `memories_v2/`、`memories_2.sqlite`。アーティファクトには `memory_summary.md`、ロールアウト要約、スキル、拡張、(V1) `MEMORY.md` / `raw_memories.md` が含まれます。

セッション開始時、廃止された profile/recall/core/tidy 設定と `consolidation_max_turns` は、元の設定を `memories.json.before-codex-only.bak`(既存なら番号付き接尾辞)にバックアップした後に削除されます。マイグレーション通知が一度表示されます。プロバイダ選択とその他の設定はそのまま保持されます。レガシースキーマ/ステータスラベルは SQLite スナップショットバックアップ `*.before-codex-schema.bak` の後にアップグレードされ、古い `failed` ジョブは上流の `error` ジョブになります。既存の実験テーブルは触れられず使用されません。ダウンロードされた実験モデルキャッシュは自動削除されません。

抽出は過去のセッション内容を設定された pi プロバイダに送り、統合は選択されたメモリアーティファクトを同じプロバイダインターフェースで送ります。秘匿情報の除去はベストエフォートです。SDK 圧縮は追加のプロバイダリクエストを行うことがあります。有料プロバイダに対するライブ検証は保証しません。

## 検証

`npm run check` · `npm test` · `git diff --check` · `npm pack --dry-run --json --ignore-scripts`

テストは一時状態、固定モデル応答、実際の pi SDK セッション(65 ツールターン、キャンセル、オーバーフロー圧縮と再開)、ローカル HTTP ペイロードキャプチャ、並行プロセス、インストール済みパッケージのスモークテストを使用します。上流テストベクタの原文がフィルタリング、切り詰め、引用、適格性を検証します。ソース/プロンプトのハッシュがテストを固定コミットに結び付けます。カバレッジとホスト制限は parity マトリクスを参照してください。

隔離の上書き: `PI_CODEX_MEMORY_HOME`、`PI_CODEX_MEMORY_SESSIONS`。`PI_CODEX_MEMORY_WAIT_ON_SHUTDOWN=1` はヘッドレススモーク実行で進行中の作業を完了まで待ちます。

## ライセンス

独自実装は MIT、ベンダリングされた Codex ソース/テンプレートは Apache-2.0。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照。
