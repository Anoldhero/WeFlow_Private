import type { Dataset } from './contracts.js'

export function sampleDatasets(): Dataset[] {
  const date = new Date()
  date.setHours(9, 20, 0, 0)
  const beginning = Math.floor(date.getTime() / 1000)
  const chats: Array<{ name: string; kind: 'group' | 'private'; rows: Array<[string, string]> }> = [
    { name: '秋日产品计划', kind: 'group', rows: [
      ['林可', '大家早上好，整理一下周五发布前需要完成的事情。'],
      ['我', '首页和会话列表的设计已经确认，今天开始最后一轮体验检查。'],
      ['周远', '云端接口联调已完成，目前还差弱网情况下的重试验证。'],
      ['林可', '周远负责接口验证，明天下午 3 点前把结果发到群里。'],
      ['我', '我负责完成首次使用引导，把技术配置改成用户能理解的步骤，周四中午前交付。'],
      ['许宁', '收到，我准备两组用户测试，分别覆盖首次安装和已有聊天数据的场景。'],
      ['林可', '用户测试安排在周四下午，问题清单当晚汇总。'],
      ['周远', '一个待确认点：免费用户的每日 AI 分析次数要定为多少？'],
      ['我', '先按 30 次进行体验测试，正式额度由运营确认。不要写死在客户端。'],
      ['许宁', '还建议在分析前让用户看到发送内容，默认隐藏联系人姓名和联系方式。'],
      ['林可', '同意。发布前要确认取消生成、额度不足、服务暂时不可用这三个状态。'],
      ['我', '已记下。周四复盘时一起确认是否可以周五发布。']
    ] },
    { name: '林可', kind: 'private', rows: [
      ['林可', '关于新软件，我希望用户打开后就知道下一步该做什么。'],
      ['我', '入口只保留连接微信、导入记录和体验示例。'],
      ['林可', '可以，AI 结果最好能够回到原始消息，方便核对。'],
      ['我', '会给结论加消息引用，并提供保存结果和导出 Markdown。']
    ] },
    { name: '周末徒步小队', kind: 'group', rows: [
      ['陈舟', '周六早上 8 点在公园南门集合，全程大约 8 公里。'],
      ['我', '天气预报有小雨，要不要准备备用路线？'],
      ['许宁', '如果下雨就改成城市博物馆，周五晚上确认。'],
      ['陈舟', '我负责查看天气并通知大家。每个人带好水和雨具。']
    ] }
  ]
  return chats.map((chat, index) => {
    const messages = chat.rows.map(([sender, text], row) => ({ id: `sample-${index}-${row}`, timestamp: beginning + row * 240 - index * 86400, sender, self: sender === '我', text, type: 'text' as const }))
    return { session: { id: `sample:${index}`, name: chat.name, kind: chat.kind, source: 'sample', lastTimestamp: messages.at(-1)!.timestamp, preview: messages.at(-1)!.text, count: messages.length }, messages }
  })
}
