# 发布到 npm 的清单

## 发布前

- [ ] `package.json` 的 `name` 是 `dsh-nga`（非 scoped，发布后就是公开包）
- [ ] `version` 从 `0.0.1` 起；**以后每次发新版都要改大**，否则 npm 会拒
- [ ] `files` 只列要发的东西：`index.js`、`login.js`、`client.js`、`cordis.patch.yml`、`README.md`、`LICENSE`
      （`selftest.mjs`、`PUBLISH.md` 不在 `files` 里，不会被发出去）
- [ ] `repository` / `homepage` / `bugs` 指向 `github.com/JackBoosY/dsh-nga`
- [ ] `README.md` 里没有还没实现的承诺

## 发布

```sh
# 1) 登录（要用户名、密码、邮箱 OTP）
npm login

# 2) 确认当前身份
npm whoami

# 3) 看一眼会发出去哪些文件（不出错就别发布）
cd C:\Users\JackBoos\Documents\deepseek-harness\default-workspace\plugins\dsh-nga
npm pack --dry-run

# 4) 发布（npm 可能会再要一次 OTP）
npm publish
```

## 发布后

- [ ] 打开 `https://www.npmjs.com/package/dsh-nga` 看一眼页面和 README
- [ ] 用一个干净的地方验一次安装：
      `npx -y dsh plugin --profile web add dsh-nga`（或者你那台机器上直接 `dsh plugin add dsh-nga`）
- [ ] 如果 README 要改：改完、推 GitHub、**再发一个版本**（`npm version patch` 然后 `npm publish`）

## 常见失败

| 报错 | 原因 |
| --- | --- |
| `E403 ... you must be logged in` | 没 `npm login`，或者 session 过期 |
| `E403 ... two-factor authentication` | 账号开了 2FA，发布时要 OTP |
| `E409 ... version already exists` | 版本号没改 |
| `EPUBLISHCONFLICT` | 包名被占（`dsh-nga` 目前是空的，不会） |
| `E404 ... scope` | 用了 scoped 名字但没 `--access public` |
