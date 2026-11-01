# dsh-nga

DeepSeek Harness 插件：读取 [NGA](https://bbs.nga.cn) 论坛的帖子。

## 安装

```sh
dsh plugin --profile web add github:JackBoosY/dsh-nga
```

安装后重启 DSH。

## 配置

打开「设置 → NGA」，依次：

1. 填写 NGA 账号与密码；
2. 点击「拿验证码」，验证码图片会显示在表单中；
3. 查看图片并输入图中字符；
4. 点击「登录」。成功后显示当前登录的 uid。

退出登录：同一页面点击「退出登录」。

## 使用

登录后可通过 Agent 工具 `nga_read` 读取帖子：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `tid` | string | 必填，帖子 id（`read.php?tid=` 后的数字） |
| `page` | integer | 单页页码，默认 1；给了 `pages` 时忽略 |
| `pages` | string | 一次读多页：`"2"` 或 `"1-3"`，单次最多 5 页 |
| `authorOnly` | boolean | 只看楼主（自动解析楼主 uid） |
| `authorId` | string | 仅显示该用户 uid（「只看TA」） |
| `maxChars` | integer | 返回文本截断长度，默认 8000 |

返回内容是**按楼层排好的文本**，每层带楼层号、作者、时间：

```
标题：<帖子标题>
版面：<版面名>
共 37 层

第 1 页 / 共 3 页，本页 17 层

【楼主】<作者>  2019-08-27 06:49
<正文>

【1 楼】<作者>  2019-08-27 06:54
<正文>
```

引用块显示为 `[引用]`，图片显示为 `[图]`。

已知限制：**只读单页时，「共 N 页」是下限，不一定是总数**——NGA 的 HTML 只给出相邻页的链接，读第 1 页只能看到第 2 页。一次读多页会取各页见到的最大值，更接近真实页数。

## 回复

工具 `nga_reply` 会以当前登录账号**公开发布**一条回复，别人看得见，也删不干净。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `tid` | string | 必填，帖子 id |
| `content` | string | 必填，正文；至少 6 个字，上限 65530 字节 |
| `fid` | string | 版面 id；不给会自动从帖子页解析 |
| `pid` | string | 给了就是楼中楼（回复某一层） |
| `confirm` | boolean | **必须为 true**，否则工具直接拒绝、不发请求 |

协议：先 `POST post.php?action=reply&fid=..&tid=..` 取页面里的一次性 `auth`，再用它带
`step=2 / post_content / pid / __inchst=UTF-8` 提交同一个地址。

> 注意：这条路径只验证到"服务端接受请求形状"（空正文会被拒：`内容过短或过长(ERROR: 2048)`），
> **尚未做过一次真实发布验证**。第一次真发之前，请先在一条无关紧要的帖子里试。

## 看某个用户发过什么

工具 `nga_user`，只读。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `uid` | string | 必填，NGA 用户 id；填 `me` 就是当前登录的账号 |
| `includeReplies` | boolean | `true` 列他发的帖（含回复摘录）；默认只列他开的主题 |
| `page` | integer | 页码，默认 1 |
| `maxItems` | integer | 最多显示多少条，默认 30 |

**这个功能需要浏览器的登录 cookie**，光有 `access_uid` / `access_token` 不行：

- NGA 对 `thread.php?authorid=…` 会检查请求"像不像浏览器"。只带 token 的话，连发两三个就整片 503（跟间隔快慢无关）；
- 补上浏览器的 UA、`Accept-Language`、`sec-fetch-*`、`sec-ch-ua` 之后，还要带上 `ngaPassportUid` / `ngaPassportCid` 两个 cookie；
- 放法：写进 `~/.dsh/nga-creds.json` 的 `cookie_uid` / `cookie_cid`（或环境变量 `NGA_COOKIE_UID` / `NGA_COOKIE_CID`）；
- 这两个值在浏览器 F12 → Application → Cookies → `https://bbs.nga.cn` 里能取到。它们等同于登录凭证，别外传；
- 这个页面要用 **GET**：POST 会拿到一个约 3KB 的空壳页（状态码还是 200，但没有数据）。

数据来自 `thread.php?authorid=<uid>`（主题）和 `thread.php?authorid=<uid>&searchpost=1`（帖子）。

## 设置里的「跑一轮巡检」

设置 → NGA 里，登录之后会多出一块「巡检机器人」，一个按钮跑完整条链路：

1. 拉版面第一页的帖子（默认 `fid=-7` 网事杂谈）；
2. 挨个查楼主的发帖记录：主题数、以及「回复」那一列是不是空的；
3. 判定：**主题 ≥3 个，且从没回过帖** → 记为可疑；
4. 勾了「真的发出去」才对可疑的楼主在他那条帖子里回一句话，不勾只报告。

默认**不勾**，也就是只读不写。一轮最多查 12 个楼主，请求间隔 1~1.8 秒随机。

> 实测：网事杂谈前 6 页、120 多个楼主里，符合「只发主题、从不回帖」的一个都没有。
> 所以这个按钮多数时候是空转——这是数据的问题，不是按钮坏了。



支持：

- 读取帖子正文，按楼层拆解（楼层号 / 作者 / 时间 / 内容）；
- 分页，以及一次读取多页（最多 5 页）；
- 只看楼主（`authorOnly`）、只看指定用户（`authorId`）；
- 解析帖子标题与版面名；
- 看某个用户发过的主题 / 帖子（`nga_user`）；
- 回复（`nga_reply`，需显式 `confirm: true`）。

不支持：

- 发新主题、收藏、点赞、查看提醒；
- 搜索与版面列表；
- 读取用户资料页。

## 验证码处理

验证码由用户手动识别输入。插件不会尝试自动识别图形验证码。

## 凭证

- 账号与密码仅用于当次登录请求，不做持久化；
- 登录成功后，`access_uid` / `access_token` 保存在 DSH credentials 服务中（键名 `dsh-nga/account`），不对外发送；
- 清除方式：点击「退出登录」，或删除该 credentials 记录。

## 实现说明

NGA 的登录与读取协议参考以下公开实现，并经过抓包核对：

- [BugenZhao/MNGA](https://github.com/BugenZhao/MNGA)
- [jo32/dsh-nga-reader](https://github.com/jo32/dsh-nga-reader)

## 许可

MIT
