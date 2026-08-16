# dsh-session-sync

一个 DSH Web 插件，注册 `/sync` 斜杠命令，用于在不同电脑之间同步 DSH 的**会话记录**（`%DSH_HOME%\sessions`）和**图片附件**（`%DSH_HOME%\attachments`），实现"这台干完，那台接着聊同一段对话"。

数据落在一个目标目录 `target` 里（结构：`target\sessions\...`、`target\attachments\...`），可以是：

- 一个 **git 仓库**（推荐：私有 GitHub/Gitee 仓库，或者本地/内网 bare 仓库），`/sync push` 会 `git commit + push`；
- 一个**纯目录**（云盘同步目录如 OneDrive / 坚果云、NAS 挂载盘），配置里 `git: false` 即可，只做目录镜像。

## 命令

| 命令 | 作用 |
|---|---|
| `/sync status` | 查看 DSH_HOME、target、git remote/分支、两端会话数量 |
| `/sync push` | 先把所有活跃会话刷新落盘，再把 `sessions` + `attachments` 镜像进 target，最后 `git add -A && commit && push` |
| `/sync pull` | 先 `git pull`（或直接从目录复制），再把 target 里的会话/附件**递归合并**回本机 `%DSH_HOME%`：同名条目被 target 覆盖，本机独有内容（包括同一项目目录下的独有会话）全部保留 |
| `/sync init` | 创建 target 目录并 `git init`（若未初始化），然后手动 `git remote add origin <地址>` |

## 安装

已安装到 web profile。若需在另一台机器重新安装，把本包放进 profile 的 `node_modules`：

```
%DSH_HOME%\profiles\web\node_modules\dsh-session-sync\
```

并在 `%DSH_HOME%\profiles\web\cordis.patch.yml` 中加入（注意新行必须包在 `insert` 里，不能写成裸行覆盖）：

```yaml
- insert:
    - id: session-sync
      name: 'dsh-session-sync'
      config:
        target: 'D:\dsh-sync'     # 改成你的同步目录/仓库路径
        git: true                 # false = 纯目录镜像（云盘）
        pushRemote: true          # push 后是否 git push
        pullRemote: true          # pull 前是否 git pull
        copyAttachments: true     # 是否同时同步图片附件
```

保存后重启 `dsh web` 生效（也可以先 `dsh --profile web --dump-config` 确认行已进入配置树）。

## 注意

- 两台机器各装一份插件，`target` 指向同一份（git 仓库各自 clone，或云盘同一目录）。
- **同一时间只在一台机器上运行 DSH**（日志是追加式写入，无跨进程锁）。
- 两台机器 DSH 版本尽量一致（会话日志有格式版本号，跨版本会拒绝加载）。
- 会话头部记录了创建时的工作目录（如 `D:\DSHarness`），换机器继续对话时工具命令在该机器的文件系统上执行，请保持路径一致或存在。
- `push` 的镜像会删除 target 中本机没有的会话（以本机为准）；`pull` 是递归合并，不会删除本机独有内容（只覆盖同名条目）。约定：先 push 再 pull，别两边同时乱改。
- 不要同步/提交 `%DSH_HOME%` 下的 `.credentials.yaml`、`settings.yaml`、`profiles\`、`storages\`——它们是机器本地的。
