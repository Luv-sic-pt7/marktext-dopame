# Dopame JS 包上传与启动经验文档

> 面向后续 agent 的操作手册：把 `packages/dopame` 的 acde JS 应用包构建、上传到 Dopame 服务器（192.168.1.68）并启动验证。
> 基于 dopame-port / develop 分支成功部署的经验整理（2026-11-14 实测通过）。

## 0. 环境速览

| 项         | 值                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 服务器     | `ssh -p 2203 root@192.168.1.68`（免密登录依赖 `/root/.ssh/authorized_keys`，首次用 `ssh-copy-id` 装一次）                     |
| 服务器系统 | Dopame OS（Arch 系 live 系统），运行时 `acdert`（acdebin-system 0.0.11，contract level 1），**没有** `acde` CLI，**没有外网** |
| 包安装目录 | `/usr/share/acde/packages/<包目录名>`（包目录名 = manifest 里的 app id，如 `marktext-dopame`）                                |
| 本机       | macOS，`~/.acde/bin/acde`（SDK 0.0.9 附带）、pnpm/bun、Node ≥ 22.12                                                           |

## 1. 本机构建 .acde 包

```bash
cd /path/to/marktext-dopame
npx pnpm@10.33.4 install            # 根目录装依赖（见 §5 网络注意事项）
npx pnpm@10.33.4 -C packages/dopame run build   # 即 acde build → 产出 packages/dopame/.acde/
```

`.acde/` 结构：`package.json`（含 acde manifest：apps/assets）+ `web/`（vite 产物）。

## 2. 上传与安装（服务器）

```bash
cd packages/dopame
COPYFILE_DISABLE=1 tar -C . -czf /tmp/<name>.acde.tgz .acde   # 必须 COPYFILE_DISABLE=1，否则带 ._* 垃圾文件
scp /tmp/<name>.acde.tgz 192.168.1.68:/tmp/

ssh -p 2203 root@192.168.1.68 '
  cd /tmp && tar xzf <name>.acde.tgz \
  && rm -rf /usr/share/acde/packages/<app-id> \
  && mv .acde /usr/share/acde/packages/<app-id> \
  && acdert applications /usr/share/acde/packages'
```

- `acdert applications <dir>` 会为所有已安装包生成 `acde-<app-id>.desktop` 启动器（桌面 Dock 与"打开方式"依赖它）。不生成就点不开/`open` 报 "no app <id>"。

## 3. 启动与验证

**关键事实：运行中的 acde 会话只在启动时扫描包目录，装新包后必须重启会话。**

```bash
# tty1 主会话重启（greetd 的 initial_session 只在开机执行一次，重启后进 default_session；
# 要让 default_session 也直接进桌面，先把 /etc/greetd/config.toml 两处 command 都改为 "/usr/bin/acdert"）
ssh -p 2203 root@192.168.1.68 'systemctl restart greetd'

# 打开应用（在会话里启动 marktext-dopame 并打开文件）
ssh -p 2203 root@192.168.1.68 'acdert open --app marktext-dopame /tmp/hello.md; echo $?'
# 退出码 0 即成功

# 验证日志（页面加载完成且无 JS 错误）
ssh -p 2203 root@192.168.1.68 'journalctl -b | grep -E "acde_host|acde js" | tail -10'
# 预期出现 page load started → loaded → shell running → first frame；不应出现 "acde js: Error"
```

## 4. 远程可视化（RDP）

服务器没有 `acde` CLI，直接调运行时脚本开一个独立 off-screen 会话（不影响 tty1）：

```bash
# 凭据文件（0600）：
#   /root/.config/acde/rdp.env
#     ACDE_RDP_USER=acde
#     ACDE_RDP_PASSWORD=<密码>
ssh -p 2203 root@192.168.1.68 '
  mkdir -p /root/.config/acde && printf "ACDE_RDP_USER=acde\nACDE_RDP_PASSWORD=<密码>\n" > /root/.config/acde/rdp.env && chmod 600 /root/.config/acde/rdp.env
  nohup env ACDE_RDP_USER=acde ACDE_RDP_PASSWORD=<密码> XDG_CONFIG_HOME=/root/.config \
    /usr/lib/acdebin-system/acde-rdp [--desktop <桌面id>] > /tmp/acde-rdp.log 2>&1 < /dev/null &'
```

- 默认监听 `0.0.0.0:3390`（`ss -tlnp | grep 3390` 确认）。
- Mac 客户端：App Store 装 **"Windows App"**（微软 RDP 客户端），连接 `192.168.1.68:3390`，用户名 `acde`。**Finder 的 `vnc://` 不行**（VNC ≠ RDP 协议）。自签名证书警告点"信任"。
- RDP 会话是独立会话，启动时会重新扫描包目录（装新包后无需重启 tty1 也能在 RDP 里看到）。
- 系统重启后 `acde-rdp.service`（systemd 用户单元）会因 rdp.env 就位自动拉起。

## 5. 网络与环境的坑（血泪教训）

1. **git 访问 GitHub 报 `SSL_ERROR_SYSCALL`** → `git config http.sslVersion tlsv1.2`（本机网络对 TLS1.3 有干扰）。
2. **npm/COS 域名超时（DNS 解析到 198.18.x 假 IP）**：本机 TUN 代理路由坏了，但显式代理可用：
   `export HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 NO_PROXY=localhost,127.0.0.1,192.168.0.0/16` 后再 install/构建。
3. **服务器本身无外网**：依赖必须在本机装好，只上传构建产物。
4. **`pkill -f` 自匹配陷阱**：模式串会出现在远程 shell 自己的命令行里，把 SSH 会话一起杀掉 → 用 `pkill -f "...d[p]ame"` 括号技巧。
5. **live 系统重启丢一切**：`/` 是 overlay，重启后主机密钥重生成（known_hosts 报 "HOST IDENTIFICATION HAS CHANGED" 属正常，`ssh-keygen -R "[192.168.1.68]:2203"` 后重连）、`authorized_keys` 丢失（重新 `ssh-copy-id`）、已装的包和配置全部消失（重新部署）。
6. **SSH 偶发抖动**（No route to host / banner timeout / reset）：重试即可，加 `-o ServerAliveInterval=5 -o ConnectTimeout=15`。
7. **macOS tar 带 `._*` AppleDouble 文件** → 打包时 `COPYFILE_DISABLE=1`。
8. 应用 manifest 里声明的 `services`（如 `marktext-agent`）只存在于提供它的桌面会话里：需要时用 `--desktop <id>` 启动会话（acdert 支持 `--desktop <id|dir>`）。

## 6. 常用命令速查

```bash
# 服务器侧
acdert desktops                      # 列出已安装桌面（* = 默认）
acdert applications /usr/share/acde/packages   # 重新生成 .desktop 启动器
acdert open --app <app-id> <文件>     # 在运行中的会话打开应用
journalctl -b | grep acde_host        # 会话/应用加载日志
ss -tlnp | grep -E "3390"             # RDP 是否在监听
ps -o pid,cmd -C acdebin-system       # 查看会话进程
```
