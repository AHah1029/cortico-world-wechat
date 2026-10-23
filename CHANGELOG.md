## 未发布

- 图片:收到 `[图片]` 时回到那个会话,按 `mmui::ChatImageItemView` 的矩形截一张 png,挂成事件附件。
- 语音:按 `mmui::ChatVoiceItemView` 抓一张图,并点气泡上的「转文字」,把识别出的字写进正文
  (`（转文字:…）`)和 `meta.voiceText`。
- 新配置 `worlds.wechat.captureMedia`(默认开),走环境变量 `WX_CAPTURE` 传给桥。
- 桥:调试用 `chat="@"` 表示「就用当前会话」,不切也不切回,方便手动滚到某条消息再抓。
- 测试:补了图片/语音事件(附件挂载、读不到文件时降级)两条用例。

## 0.1.0

- 第一版:UI Automation 桥 + 起草/确认两道门,`wx_chats` / `wx_read` / `wx_draft` / `wx_confirm`。
