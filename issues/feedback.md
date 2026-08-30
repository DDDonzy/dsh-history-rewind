## 鼠标只有点击 左右history panel 左右两边空白位置才可以退出panel。
- 点击事件修改，点击事件默认退出panel，只有点击中有事件得卡片，才触发对应得事件。

## 取消每个卡片右边得眼睛图标

## panel下面，添加一个按钮 CURATED SESSION 右对齐。不要用橙色，使用默认的dsh按钮风格，取代当前版本卡片右边眼睛 的功能。

## CREATE CURATED SESSION 按钮采用CURATED SESSION一样的风格，右对齐，不要用橙色

## CONTEXT CURATION 创建提示窗口 修改
-```EXPERIMENTAL FEATURE 新会话会继承当前工作区、Agent 配置和模型路由，但拥有独立的会话历史与后续快照。它不会复用当前会话的模型缓存。```这片布局删掉，不需要这些内容
- CONTEXT CURATION 按钮改为确定，和dsh风格一致

## 由于我们在面板下面加入了  CURATED SESSION 按钮，我希望这个按钮根据卡面数量动态计算位置，而不是永远在panel最下面，比如有2个卡面，就在2个卡片下面，当有滚动条（意味着卡片很多的时候）放在panel最下面

## panel 也添加 x 按钮，在panel 右上 ，同样根据卡片动态找到位置，而不是固定在panel 右上。 选择context 面板的 x 也是

## 创建的新会话名，不要和原来会话一样：CTX-原来会话名