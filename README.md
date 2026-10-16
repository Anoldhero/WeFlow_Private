# WeFlow-Private

![image-20261016110440850](C:\Users\admin\AppData\Roaming\Typora\typora-user-images\image-20261016110440850.png)

这里要区分三类信息：

| 类型               | 用途                   | 保存位置                       |
| ------------------ | ---------------------- | ------------------------------ |
| 微信账号及读取资料 | 读取用户选定的本机聊天 | 用户电脑                       |
| 知聊账号           | 登录软件、使用云端额度 | 云端账号库；客户端缓存登录状态 |
| 模型供应商 API Key | 由服务端调用模型       | 运营方服务器环境配置           |

**最终用户只登录知聊，不填写模型 Key，也不需要安装 Node、pnpm、Docker或额外的 Agent。** 正式安装包内置你的产品服务地址。

主要模块及阅读入口如下：

| 模块        | 职责                                         | 入口                                                         |
| ----------- | -------------------------------------------- | ------------------------------------------------------------ |
| 界面        | 社群报告、对话助手、记录检索、任务中心、设置 | [App.tsx](E:/LZY/Project_Self/WeFlow-AI/src/App.tsx)         |
| 桌面主进程  | 安全 IPC、本机数据、云端客户端、任务协调     | [main.ts](E:/LZY/Project_Self/WeFlow-AI/electron/main.ts)    |
| 数据接入    | 微信多账号、WeFlow API、JSON/JSONL 导入      | [data-source.ts](E:/LZY/Project_Self/WeFlow-AI/electron/data-source.ts) |
| 报告业务    | 周期、栏目模板、脱敏、报告结构与引用         | [group-report.ts](E:/LZY/Project_Self/WeFlow-AI/shared/group-report.ts) |
| 云端接口    | 注册登录、邀请码、额度、流式请求             | [app.ts](E:/LZY/Project_Self/WeFlow-AI/server/app.ts)        |
| AI 报告编排 | 分批提炼、逐级合并、引用校验                 | [report-service.ts](E:/LZY/Project_Self/WeFlow-AI/server/report-service.ts) |
| 后台任务    | 队列、进度、暂停、恢复、取消                 | [task-manager.ts](E:/LZY/Project_Self/WeFlow-AI/electron/task-manager.ts) |
| 部署        | 独立云端镜像、HTTPS、持久化                  | [compose.production.yaml](E:/LZY/Project_Self/WeFlow-AI/compose.production.yaml) |

云端目前按**单实例 SQLite**设计，不应直接增加多个副本共享同一数据库。聊天正文不写入本项目云端数据库；报告和原文快照保存在用户电脑。

当前面向用户的功能包括：

- **日报、周报**：选群、选日期，按北京时间的日或自然周处理；每期最多 12,000 条、60 万字符，超限明确提示。
- **报告定制**：栏目勾选、排序、改名、自定义；三种风格、字体与字号调整。已有内容的排版调整不需要重新调用模型。
- **来源核对**：报告引用编号可查看本机保存的原文快照。
- **记录检索**：按日期、成员、关键词查看和统计，支持筛选结果导出。
- **对话助手**：总结、待办提取、针对聊天提问。
- **导出及任务**：Markdown、SQL、JSON、JSONL；报告 HTML、PNG、PDF；任务进度和导出暂停/恢复。
- **定时导出**：间隔、时间范围、截止条件、无变更跳过。需要软件运行并连接原数据来源。
- **本地媒体**：语音转写、图片解密已接入；图片解密不等于 OCR，相关实机验收尚未完成。

当前定时功能用于**原始聊天导出**；云端日报、周报仍在用户确认发送内容后生成。

------

Windows 本地开发先初始化当前 PowerShell。下面使用这台机器已经确认存在的运行时，不修改系统默认 Node：

```
Set-Location -LiteralPath 'E:\LZY\Project_Self\WeFlow-AI'

$nodeExe = 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$pnpmCli = 'E:\Software\nodejs\node_global\node_modules\pnpm\bin\pnpm.cjs'

$env:Path = "$(Split-Path -Parent $nodeExe);$env:Path"

function pnpm {
    & $nodeExe $pnpmCli @args
}

node --version
pnpm --version

# 完整安装项目依赖
pnpm install --frozen-lockfile
```

项目要求 **Node 24、pnpm 9.15.4**。以下 `pnpm` 命令在完成上述初始化的终端执行。

第一次接手，建议先运行无需模型 Key 的演示环境：

```
pnpm demo
```

启动后访问 [本机预览](http://127.0.0.1:5178/)。可以使用“以演示账号体验”，公开测试账号为：

```
账号：demo
密码：local-demo-only
```

演示回复由模拟服务生成。需要调试 Electron 时，先停止当前模式，再运行：

```
pnpm demo:desktop
```

全部启动模式对应关系如下，**同一项目一次选择一种**：

| 命令                     | 实际启动                     | 配置要求      |
| ------------------------ | ---------------------------- | ------------- |
| `pnpm demo`              | 模拟 API＋浏览器界面         | 无模型配置    |
| `pnpm demo:desktop`      | 模拟 API＋界面＋Electron     | 无模型配置    |
| `pnpm dev`               | 本机真实 API＋浏览器界面     | 服务端 `.env` |
| `pnpm dev:desktop`       | 本机真实 API＋界面＋Electron | 服务端 `.env` |
| `pnpm dev:cloud`         | 浏览器界面，连接外置云端     | `.env.client` |
| `pnpm dev:desktop:cloud` | 界面＋Electron，连接外置云端 | `.env.client` |

开发界面默认使用 **5178**，本机 API 默认使用 **4310**。正式安装版直接加载本机界面资源，不需要运行 Vite。

停止开发环境，可以在启动终端按 **Ctrl+C**，也可以在另一个 PowerShell 中独立执行：

```
Set-Location -LiteralPath 'E:\LZY\Project_Self\WeFlow-AI'

$nodeExe = 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'

# 查询当前项目
& $nodeExe .\scripts\dev-control.mjs status

# 停止当前项目启动器管理的进程
& $nodeExe .\scripts\dev-control.mjs stop
```

完成初始化的终端中，也可以直接：

```
pnpm status
pnpm stop
```

`pnpm stop` 管理的是上述开发启动器，**独立运行的 API 和 Docker 服务使用各自的停止方式**。

------

连接正式云端时，只配置产品服务地址：

```
if (-not (Test-Path -LiteralPath '.env.client')) {
    Copy-Item -LiteralPath '.env.client.example' -Destination '.env.client'
}

notepad .env.client
```

文件内容如下，域名替换为你部署知聊云端的真实域名：

```
CLOUD_API_URL=https://ai.your-domain.com
```

这里填**知聊 API 地址**，不是模型供应商地址；当前部署模板使用域名根路径，不需要添加 `/v1`。

然后运行：

```
pnpm dev:desktop:cloud
```

这个模式不会启动本机 API。停止它也不会停止远端云服务。

如果是在本机开发云端 API，则准备服务端配置：

```
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
}

notepad .env
```

按实际供应商填写这些字段：

| 字段              | 含义                              |
| ----------------- | --------------------------------- |
| `LLM_BASE_URL`    | 模型服务基础地址                  |
| `LLM_API_KEY`     | 服务端持有的供应商密钥            |
| `LLM_MODEL`       | 模型标识                          |
| `LLM_PROTOCOL`    | `chat-completions` 或 `responses` |
| `LLM_TOKEN_FIELD` | 按供应商要求选择令牌上限字段      |

启动本机联调：

```
pnpm dev:desktop
```

也可以单独构建和运行 API：

```
pnpm build:server
pnpm server
```

独立 API 在其终端按 **Ctrl+C** 停止。另一个已初始化的终端可以创建本地测试邀请码：

```
pnpm invite --uses 10 --days 7 --limit 30
```

这个邀请码属于当前 `.env` 指定的数据库，不是正式云端的邀请码。

常规检查与完整构建：

```
pnpm typecheck
pnpm test
pnpm build
```

------

正式云端推荐部署到 Linux 服务器。前提是已经安装 Docker Engine、Compose，并将完整项目源码放到例如 `/opt/zhiliao`；域名已解析到服务器，80、443 端口可用。

在服务器 Bash 中执行：

```
cd /opt/zhiliao

if [ ! -f .env.production ]; then
    cp .env.production.example .env.production
fi

chmod 600 .env.production
nano .env.production
```

主要配置如下。示例域名、密钥和模型名称必须替换：

```
CLOUD_DOMAIN=ai.your-domain.com
NODE_ENV=production
AI_PROVIDER=compatible

LLM_BASE_URL=https://your-model-provider.example/v1
LLM_API_KEY=替换为实际服务端密钥
LLM_MODEL=替换为实际模型标识
LLM_PROTOCOL=chat-completions
LLM_TOKEN_FIELD=max_completion_tokens

LLM_MAX_OUTPUT_TOKENS=1800
REPORT_MAX_OUTPUT_TOKENS=8192
LLM_TIMEOUT_MS=90000
DAILY_REQUEST_LIMIT=30
SESSION_TTL_DAYS=7
```

密钥只保存在服务器文件中。生产环境不会创建默认演示账号。

定义当前终端的部署命令，再校验、构建和启动：

```
dc() {
    docker compose --env-file .env.production -f compose.production.yaml "$@"
}

dc config --quiet
dc up -d --build
dc ps
```

检查服务：

```
# 域名替换为实际域名
curl --fail https://ai.your-domain.com/health
curl --fail https://ai.your-domain.com/readyz

# Ctrl+C 只退出日志跟踪，不停止容器
dc logs -f ai gateway
```

`/readyz` 检查服务配置与数据库可用性。部署后还应通过客户端实际生成一份测试报告，确认供应商模型调用正常。

生产域名提供 API，桌面安装包提供界面，因此访问域名根路径没有网页首页是正常的。

创建生产邀请码：

```
dc exec ai node dist-server/invite.mjs --uses 20 --days 30 --limit 30
```

维护前在线备份数据库，并复制到服务器当前目录：

```
backup_name="cloud-$(date +%Y%m%d-%H%M%S).sqlite"

dc exec -T ai node dist-server/backup.mjs \
    --out "/app/data/backups/$backup_name"

mkdir -p backups

dc cp "ai:/app/data/backups/$backup_name" "./backups/$backup_name"
```

日常启停和更新命令：

```
# 停止容器，保留数据
dc stop

# 恢复已有容器
dc start

# 重启 API 进程
dc restart ai

# 修改源码或环境配置后，重新构建并应用
dc up -d --build

# 关闭并移除容器、网络，保留数据库和证书卷
dc down
```

**不要给 `down` 添加 `-v`**，否则会删除持久卷。修改环境配置后使用 `up -d` 应用，单纯 `restart` 不会重新读取新的环境配置。

------

制作面向用户的 Windows 安装包，在 Windows 开发终端中完成依赖安装，并将 `.env.client` 指向已经部署的正式知聊 API，然后执行：

```
Set-Location -LiteralPath 'E:\LZY\Project_Self\WeFlow-AI'

pnpm typecheck
pnpm test

pnpm package --out-dir release/0.3.1

node scripts/verify-release.mjs release/0.3.1/win-unpacked
```

构建成功后，安装器输出到：

```
E:\LZY\Project_Self\WeFlow-AI\release\0.3.1
```

用户安装后的流程是：**登录知聊 → 连接微信或导入记录 → 选择群聊、周期和模板 → 确认生成 → 导出分享**。模型切换和供应商密钥更新由服务器维护，产品服务域名不变时，客户端无需因此重新配置。

需要保留的工程边界是：

- 当前尚未生成 0.3.1 安装器，旧预览包不会自动变成新版本。
- 今天复核，三个语音依赖仍缺失；语音功能及完整打包需先补齐依赖。
- 真实微信、界面和 PNG/PDF 实机验收仍未完成；此前原生渲染出现 `0xC0000135 / ERR_FAILED`。
- 云端容器此前只完成配置校验，尚未在本任务中实际部署并验证真实模型。
- 升级后的登录缓存按服务地址隔离，需要重新登录一次；旧本机数据保留。演示桌面使用独立的 `data/desktop-demo`。
- 正式商业分发还需处理 WeFlow 授权、客户端签名与安装验收。



### 不上传源码至服务器的方式：

第一步，在 CentOS 上检查环境。CentOS 是系统名称，CPU 架构还需要确认：

```
hostnamectl
uname -m

sudo docker version
sudo docker compose version

# 检查是否已有程序使用 HTTP/HTTPS 端口
sudo ss -lntp '( sport = :80 or sport = :443 )'
```

架构对应关系：

- `x86_64`：后面的构建平台使用 `linux/amd64`。
- `aarch64`：改用 `linux/arm64`。

本流程假定 **80、443 可用**。如果已经有 Nginx、宝塔或其他网站占用，需要复用或调整现有网关，不能直接再启动一个占相同端口的 Caddy。

如果没有 `docker compose`，且服务器已配置 Docker 官方软件源，可安装插件：

```
sudo yum install -y docker-compose-plugin
sudo docker compose version
```

如果提示找不到软件包，需要根据具体 CentOS 版本和现有 Docker 软件源处理，参考 [Docker 官方 CentOS 安装说明](https://docs.docker.com/engine/install/centos/)。

同时确认域名解析到了服务器公网 IP，云控制台安全组允许 TCP 80、443。使用 firewalld 时，执行：

```
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

只在 firewalld 已运行时执行这组命令；**不需要关闭整个防火墙或 SELinux**。

------

第二步，在你的 Windows 开发电脑构建镜像。

先启动 Docker Desktop，使用 **Linux containers**。这里不需要先安装本机的语音依赖，服务端镜像有独立依赖清单。

在 PowerShell 执行：

```
Set-Location -LiteralPath 'E:\LZY\Project_Self\WeFlow-AI'

docker version
docker info --format '{{.OSType}}'

# 如果服务器 uname -m 为 aarch64，改成 linux/arm64
$platform = 'linux/amd64'

# 构建应用运行镜像
docker buildx build --platform $platform --load `
    --tag zhiliao-cloud:0.3.1 .

if ($LASTEXITCODE -ne 0) {
    throw '应用镜像构建失败，请先处理构建错误'
}

# 将网关镜像也准备好，避免服务器还需要从镜像仓库下载
docker pull --platform $platform caddy:2-alpine

if ($LASTEXITCODE -ne 0) {
    throw 'Caddy 镜像下载失败'
}
```

构建时源码留在开发电脑或构建环境。最终运行镜像包含编译后的服务端和依赖。

第三步，生成部署包。当前生产 Compose 使用 `build: .`，需要转换成 `image:`；以下命令会生成独立部署配置，不覆盖项目原文件：

```
$deployBundle = Join-Path $PWD.Path 'release\cloud-deploy-0.3.1'

New-Item -ItemType Directory -Force `
    -Path (Join-Path $deployBundle 'deploy') | Out-Null

Copy-Item -LiteralPath '.\.env.production.example' `
    -Destination (Join-Path $deployBundle '.env.production.example')

Copy-Item -LiteralPath '.\deploy\Caddyfile' `
    -Destination (Join-Path $deployBundle 'deploy\Caddyfile')

$composeText = Get-Content -LiteralPath '.\compose.production.yaml' -Raw

$composeText = $composeText.Replace(
    '    build: .',
    '    image: ${ZHILIAO_IMAGE:-zhiliao-cloud:0.3.1}'
)

# CentOS 的 SELinux：为这个配置文件挂载添加私有标签
$composeText = $composeText.Replace(
    './deploy/Caddyfile:/etc/caddy/Caddyfile:ro',
    './deploy/Caddyfile:/etc/caddy/Caddyfile:ro,Z'
)

[System.IO.File]::WriteAllText(
    (Join-Path $deployBundle 'compose.production.yaml'),
    $composeText,
    [System.Text.UTF8Encoding]::new($false)
)

# 导出应用和网关两个运行镜像
docker image save `
    --output (Join-Path $deployBundle 'images.tar') `
    zhiliao-cloud:0.3.1 caddy:2-alpine

if ($LASTEXITCODE -ne 0) {
    throw '镜像导出失败'
}

# 生成传输校验文件，使用 Linux 可直接读取的换行格式
$imageHash = (Get-FileHash `
    -LiteralPath (Join-Path $deployBundle 'images.tar') `
    -Algorithm SHA256).Hash.ToLowerInvariant()

[System.IO.File]::WriteAllText(
    (Join-Path $deployBundle 'SHA256SUMS'),
    "$imageHash  images.tar`n",
    [System.Text.Encoding]::ASCII
)
```

部署包中只有镜像和配置，不包含你的原始工程目录：

```
cloud-deploy-0.3.1/
├── images.tar
├── SHA256SUMS
├── compose.production.yaml
├── .env.production.example
└── deploy/
    └── Caddyfile
```

上传到服务器，替换 SSH 用户和 IP：

```
$sshTarget = '你的SSH用户@服务器IP'

scp -r $deployBundle "${sshTarget}:/tmp/"
```

------

第四步，在 CentOS 上加载镜像、填写服务端配置。

```
sudo mkdir -p /opt/zhiliao

sudo cp -a /tmp/cloud-deploy-0.3.1/. /opt/zhiliao/

cd /opt/zhiliao

# 校验上传文件
sha256sum -c SHA256SUMS

# 加载镜像
sudo docker load --input images.tar

# 检查镜像中的 Node 和 SQLite 能否在当前服务器运行
sudo docker run --rm --entrypoint node zhiliao-cloud:0.3.1 \
  -e "require('node:sqlite'); console.log(process.version)"
```

最后一条应输出 Node 24 的版本。若旧 CentOS、内核或 Docker 出现运行错误，先处理兼容性问题，再启动正式服务。

创建实际配置文件，保留可能已经存在的配置：

```
if [ ! -f .env.production ]; then
    sudo cp .env.production.example .env.production
fi

sudo chmod 600 .env.production
sudo vi .env.production
```

填写以下关键内容，所有示例值都需要替换：

```
ZHILIAO_IMAGE=zhiliao-cloud:0.3.1

CLOUD_DOMAIN=ai.your-domain.com
NODE_ENV=production
AI_PROVIDER=compatible

LLM_BASE_URL=https://your-model-provider.example/v1
LLM_API_KEY=实际的模型供应商密钥
LLM_MODEL=实际的模型标识

LLM_PROTOCOL=chat-completions
LLM_TOKEN_FIELD=max_completion_tokens

LLM_MAX_OUTPUT_TOKENS=1800
REPORT_MAX_OUTPUT_TOKENS=8192
LLM_TIMEOUT_MS=90000
DAILY_REQUEST_LIMIT=30
SESSION_TTL_DAYS=7
```

`LLM_PROTOCOL`、`LLM_TOKEN_FIELD` 按供应商接口要求调整。**真实模型 Key 只在服务器填写，不放进镜像或客户端。**

------

第五步，启动并验收服务。

在当前服务器终端定义一个命令简写：

```
dc() {
    sudo docker compose \
      --env-file .env.production \
      -f compose.production.yaml \
      "$@"
}
```

执行：

```
# 检查配置，不打印其中的密钥
dc config --quiet

# 使用已经加载的镜像，禁止现场构建和拉取
dc up -d --no-build --pull never

dc ps
```

查看日志：

```
dc logs -f ai gateway
```

按 Ctrl+C 只退出日志查看，不会停止容器。

将下面域名替换为实际域名：

```
curl --fail --show-error https://ai.your-domain.com/health

curl --fail --show-error https://ai.your-domain.com/readyz
```

验收分三层：

1. `ai` 容器健康，`gateway` 正常运行。
2. HTTPS `/readyz` 返回成功。
3. 客户端实际生成一份测试日报，确认模型调用正常。

**`/readyz` 只证明配置和数据库就绪，不代表供应商 Key 已通过真实模型调用验证。**

正式服务没有默认演示账号。创建邀请码：

```
dc exec ai node dist-server/invite.mjs \
  --uses 10 --days 30 --limit 30
```

然后在你的客户端开发配置或打包配置 `.env.client` 中设置：

```
CLOUD_API_URL=https://ai.your-domain.com
```

这里填的是**知聊服务地址**，不填模型供应商地址，也不需要添加 `/v1`。

------

日常维护可使用以下命令：

```
# 查看状态
dc ps

# 停止服务，保留数据
dc stop

# 恢复已有容器
dc start

# 重启 API 进程
dc restart ai

# 修改环境配置或镜像版本后应用
dc up -d --no-build --pull never

# 移除容器和网络，保留数据库与证书卷
dc down
```

**不要执行 `dc down -v`**，它会删除持久卷。

升级前可在线备份：

```
backup_name="cloud-$(date +%Y%m%d-%H%M%S).sqlite"

dc exec -T ai node dist-server/backup.mjs \
  --out "/app/data/backups/$backup_name"

sudo mkdir -p backups

dc cp "ai:/app/data/backups/$backup_name" "./backups/$backup_name"
```

后续更新版本时，重新构建和传输新版本镜像，修改 `.env.production` 的 `ZHILIAO_IMAGE`，再执行 `up -d`。保持 Compose 中的项目名和数据卷配置不变。

------

长期发布建议改用**私有镜像仓库**，这样每次不必传输 tar。

在构建电脑执行，仓库地址需替换：

```
docker login registry.your-domain.com

docker tag zhiliao-cloud:0.3.1 `
    registry.your-domain.com/your-team/zhiliao-cloud:0.3.1

docker push registry.your-domain.com/your-team/zhiliao-cloud:0.3.1
```

服务器登录仓库：

```
sudo docker login registry.your-domain.com
```

将服务器配置改成：

```
ZHILIAO_IMAGE=registry.your-domain.com/your-team/zhiliao-cloud:0.3.1
```

然后：

```
dc pull
dc up -d --no-build
```

如果本机不方便构建，也可以让 CI 的 Linux 构建环境完成构建和推送，生产服务器仍只负责拉取运行。

另一个可行方法是仅部署 `dist-server`、独立云端的 `package.json` 和锁文件，在服务器用 Node 24 安装生产依赖后运行。这种方式也无需 TypeScript 工程，但要自己维护 Node、进程管理和 HTTPS；**不能只上传一个 `index.mjs`，也不应直接复制 Windows 的 `node_modules` 到 CentOS**。

最后需要区分：**不上传原始源码工程，不等于代码加密。** 镜像内仍有编译后的 JavaScript，拥有服务器管理权限的人可以查看。上述步骤尚未在你的服务器上执行，本轮只完成了现有配置核对和镜像版 Compose 转换验证