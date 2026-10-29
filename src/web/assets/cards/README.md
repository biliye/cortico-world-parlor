# 牌面素材

`cards.webp` 是网页牌桌用的雪碧图：13 列（A 2 3 4 5 6 7 8 9 10 J Q K）× 5 行
（♠ ♥ ♣ ♦，最后一行是 大王、小王），每格 200×279。`play.css` 用
`background-size: 1300% 500%` + `background-position` 取格子，整副只下一次。

## 来源与许可

牌面来自 **gitcode.com/open-source-toolkit/77d38「扑克牌全套54张高清素材」**。
那个仓库根上有 MIT LICENSE，但它的 README 又写着「仅供个人学习开发，请勿用于商业用途，
未经允许不得进行二次分发」—— 自相矛盾，按严格的那条算。

所以这张雪碧图**不进本仓库的 git**（见包根 `.gitignore`），只在私人部署里用：

- 上云的 tar 包照常带 `src/web/assets/cards/`（打 tar 时绕过 `.gitignore` 即可）。
- 要公开发布、要商用、或者别人 clone 本仓库自己部署时，先把这副牌换掉再发。
- 换法：把另一套 54 张 PNG 解压后跑 `python scripts/build-card-sprite.py <目录>`，
  覆盖 `cards.webp` 就行，网页不用改。

素材目录里不应有牌背图（原包那张彩色格纹牌背没法用），牌背由 `play.css` 现画。

## 缺图时

网页启动时会试加载 `cards.webp`；加载不到就在 `<html>` 上加 `no-card-art`，
牌面退回纯文字（只显示点数），桌子和按钮照常。
