# dsh_qzone_sticker

> 「大肥鱼会自己发说说了。」

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的 QQ 空间插件：本机静默起一份专属 Chrome（headless，不占屏幕），第一次用手机 QQ 扫码登录；之后不用你开浏览器、不用你点按钮——模型可以自己挑时机发说说，**还能按心情配上表情包图片**，每天几条、两条隔多久、公开还是仅自己都能设。

## 功能

- **扫码登录**：设置页点「生成登录二维码」，手机 QQ 扫一下就登进去；登录态存在本机 `~/.dsh/qzone-session.json` 和专属 Chrome profile 里
- **主动发说说**：`qzone_publish` 工具，支持正文 + 最多 9 张图、公开/好友/仅自己
- **按心情配图**：给 `images` 传表情包路径，或者选「让大肥鱼按心情挑」——按文案关键词从表情包目录自动挑一张
- **带图兜底**：先走空间相册接口；被拒（常见「相册不存在」）时自动改用网页 UI 发（开静默 Chrome 真实操作：填字 → 传图 → 点发表）
- **每天上限**：0 = 不限，也可设 1~999 条；两条之间至少 60 秒防刷屏
- **表情包目录可配**：换电脑/换人用就改成自己的图库路径
- **退出登录**：一键清会话 + 删专属 Chrome profile
- **会话保活**：每 20 分钟用静默 Chrome 刷一次空间主页，把 p_skey 续上，基本一整天不用重扫
- **读说说带缓存**：最近说说 10 分钟缓存（`~/.dsh/qzone-recent-cache.json`），点「刷新」才重读；接口被限时自动改从空间主页抓
- **不填内容也能发**：按当前时段自动写一句（早/午/晚/深夜），并自动按心情配图
- **登录态联网校验**：徽章不再“假装已登录”，过期会明确提示重新扫码
- **设置页**：「设置 → 发说说」，跟刷抖音/刷B站那些插件同款位置

## 安装

源码位置：`E:\虚拟机\Python\QQ空间插件`（本机所有项目都归档在 `E:\虚拟机` 下）

**方式一：接进本地 profile（开发用）**

1. 本机装 Node.js 22+，准备好 Chrome
2. 把插件接进 profile（以 desktop profile 为例）：

```json
// profiles/desktop/package.json
{
  "dependencies": { "dsh-qzone": "link:E:/虚拟机/Python/QQ空间插件" },
  "dsh": { "profile": { "bundles": ["...", "dsh-qzone"] } }
}
```

3. 在 `profiles/desktop/node_modules` 下建同名链接：
   `cmd /c mklink /J "profiles\desktop\node_modules\dsh-qzone" "E:\虚拟机\Python\QQ空间插件"`
4. 重启 DeepSeek Harness，设置里就会出现「发说说」

**方式二：插件市场（即将上架）**

上架后可在「设置 → 插件 → 发现」里搜索「QQ空间 / qzone」一键安装，无需手动建链接。

## 使用

**网页里：** 设置 → 发说说 → 生成登录二维码 → 手机 QQ 扫 → 写文案、选配图/可见范围 → 发表

**模型里（工具）：**

| 工具 | 作用 |
| --- | --- |
| `qzone_status` | 看现在登录的是哪个 QQ |
| `qzone_recent` | 读最近说说（发之前去重用） |
| `qzone_publish` | 发一条说说，可带 `images`（最多 9 张）、`visibility`（public/friends/private）；`dryRun: true` 只检查登录不发表 |

例：

> 帮我在空间发一条：「发现这个空间是我的天下了哈哈哈」，配一张大肥鱼统治世界的表情包。

## 怎么做的

- 静默 Chrome：专属 profile `~/.dsh/qzone-chrome`，`--headless=new` + `--remote-debugging-port`，通过 CDP 控制
- 扫码：在静默 Chrome 里打开 QQ 登录页，截二维码图返回给设置页；扫码确认后从 CDP 读 cookie 落盘
- 文字发表：`emotion_cgi_publish_v6` 接口
- 带图发表：先试 `cgi_upload_image` 上传；失败则用 CDP 模拟真实操作走网页 UI（`Page.setInterceptFileChooserDialog` 塞文件）
- 全程不读取、不复述、不保存 cookie 到仓库

## 安全

- 只发当前扫码登录的那个 QQ 空间
- 每天条数可设上限（0 = 不限），两条间隔 ≥60 秒
- 配图只允许图片目录下的文件
- 仓库里不含任何登录态/路径/截图

## 目录结构

```
index.js            # 插件入口：工具 + /api/qzone 路由
client.js           # 设置页「发说说」（自注册 client bundle）
lib/qzone.js        # 发表/读取 + 登录
lib/session.js      # cookie → 会话、g_tk、发表 body
lib/chrome.js       # 从本机 Chrome 读 cookie（兼容新版调试端口）
lib/qqlogin.js      # QQ 扫码接口 + 会话落盘
lib/silent.js       # 静默 Chrome + CDP 扫码
lib/uipost.js       # 网页 UI 带图发表
lib/upload.js       # 相册接口上传图片
cordis.patch.yml    # 插件配置（uin / 上限 / 间隔）
```

## License

MIT
