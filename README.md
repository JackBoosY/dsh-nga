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
| `page` | integer | 页码，默认 1 |
| `authorId` | string | 仅显示该用户（「只看TA」） |
| `maxChars` | integer | 返回文本截断长度，默认 8000 |

## 功能范围

支持：

- 读取帖子正文，支持分页；
- 只看指定作者。

不支持：

- 发帖、回复、收藏、查看提醒；
- 搜索与版面列表；
- 将帖子解析为楼层结构（当前返回纯文本）。

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
