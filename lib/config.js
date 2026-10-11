// 标的预设：同行池为人工定义（扶摇“股票所属同花顺指数查询”接口尚未开放），页面会明确标注这一口径。
export const PRESETS = {
  '300033.SZ': {
    thscode: '300033.SZ',
    name: '同花顺',
    board: '创业板',
    industry_label: '金融信息服务 / 互联网券商工具',
    peers: [
      { thscode: '300059.SZ', name: '东方财富' },
      { thscode: '300803.SZ', name: '指南针' },
      { thscode: '601519.SH', name: '大智慧' },
      { thscode: '688318.SH', name: '财富趋势' },
    ],
    peer_rule: '人工选取：A 股上市、主营为证券行情/金融信息服务软件的公司（东方财富含券商业务，可比性需打折扣）',
    benchmarks: [
      { thscode: '399006.SZ', name: '创业板指' },
      { thscode: '000300.SH', name: '沪深300' },
    ],
    // 公司类型相关的“专属维度”：金融信息服务公司的收入与 A 股交易活跃度高度相关
    drivers: ['market_activity'],
  },
  '600519.SH': {
    thscode: '600519.SH',
    name: '贵州茅台',
    board: '上交所主板',
    industry_label: '白酒',
    peers: [
      { thscode: '000858.SZ', name: '五粮液' },
      { thscode: '000568.SZ', name: '泸州老窖' },
      { thscode: '600809.SH', name: '山西汾酒' },
      { thscode: '002304.SZ', name: '洋河股份' },
    ],
    peer_rule: '人工选取：A 股高端/次高端白酒龙头',
    benchmarks: [
      { thscode: '000300.SH', name: '沪深300' },
    ],
    drivers: [],
  },
};

export const DEFAULT_THSCODE = '300033.SZ';

// 两市成交额 = 上证综指 + 深证成指成交额（用于“市场活跃度”驱动维度）
export const MARKET_TURNOVER_INDEXES = [
  { thscode: '000001.SH', name: '上证指数' },
  { thscode: '399001.SZ', name: '深证成指' },
];

export const DIMENSIONS = {
  operating_quality: { label: '经营质量', desc: '盈利能力、费用结构、利润含金量' },
  financial_trend: { label: '财务趋势', desc: '营收与利润的年度/季度同比变化' },
  valuation: { label: '估值', desc: '当前估值水平及与同行对比（接口不提供历史估值）' },
  market: { label: '行情特征', desc: '区间涨跌、波动、回撤、相对基准表现、成交活跃度' },
  industry: { label: '行业位置', desc: '在人工同行池中的规模、盈利与成长排名' },
  driver: { label: '经营驱动', desc: '按公司类型选择的专属驱动因子' },
  events: { label: '重要事件', desc: '财报披露、分红、异动原因、热度变化' },
  risk: { label: '风险', desc: '由确定性规则触发的风险信号与数据风险' },
};
