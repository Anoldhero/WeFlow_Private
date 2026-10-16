# 第三方组件

本项目的微信读取能力使用 [WeFlow](https://github.com/hicccc77/WeFlow)（作者 hicccc77 / cc）的 KeyService 和 Windows 原生组件。本次同步来源为本机 WeFlow-New 对应的 [jacklilyhello/WeFlow](https://github.com/jacklilyhello/WeFlow)，固定提交 e5b7067aa0554151d2762c6f889dd47bc1bf2f46。原始来源、文件哈希见 `vendor/weflow/manifest.json`，原始许可全文见 `vendor/weflow/LICENSE`。账号目录、富文本解析、HTTP 增量读取和本地媒体流程参考该版本，并按知聊的数据与任务接口重新实现。

WeFlow 仓库声明采用 Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International。复用、修改及分发须遵守原许可；商业用途需要另行解决授权。复制的原生二进制内部行为未在本项目中重新实现；本项目不调用其 cloudInit/cloudReport 接口。

其余依赖的版权与许可证保留在各依赖包中。正式分发前须核对所用模型服务、原生组件和全部依赖的适用许可。本预览版不表示已取得商业授权。

可选的离线语音组件使用 sherpa-onnx-node 与 silk-wasm；SenseVoice ONNX 权重与 tokens 由用户下载或从本机选择，权重不随当前源码复制。默认下载来源与 WeFlow-New 一致，为 ModelScope 的 pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue。分发权重前须另核对该权重的许可。报告使用 Windows 自带中文字体，不复制系统字体文件。
