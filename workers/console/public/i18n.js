/**
 * pvuv.ai console i18n — client-side only (no SEO involvement, §19: no framework).
 *
 * Language switching happens entirely in the browser: the choice is stored in
 * localStorage and applied by (a) translating any element carrying data-i18n /
 * data-i18n-ph / data-i18n-title, and (b) a t() helper the page's own render
 * functions call. On change we re-apply static nodes and dispatch a
 * `pvuv:lang` event so the page can re-render its dynamic content.
 *
 * Keys ARE the English source strings, so anything not yet translated falls
 * back to correct English rather than a blank or a raw key. Only the six
 * non-English dictionaries are maintained here.
 */
(function () {
  var LANGS = [
    { code: 'en', label: 'English' },
    { code: 'zh', label: '中文' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
    { code: 'de', label: 'Deutsch' },
    { code: 'fr', label: 'Français' },
    { code: 'es', label: 'Español' },
  ];

  // Each dictionary maps an English UI string → its translation. English is the
  // implicit identity dictionary (no entry needed).
  var DICT = {
    zh: {
      '← sites': '← 站点', 'visitors →': '访客 →', 'Search sites…': '搜索站点…',
      'Rolling': '滚动', 'Calendar': '日历',
      'Last 24 hours': '最近 24 小时', 'Today': '今天', 'Last 7 days': '最近 7 天', 'Last 30 days': '最近 30 天', 'Last 90 days': '最近 90 天',
      'Yesterday': '昨天', 'This week': '本周', 'Last week': '上周', 'This month': '本月', 'Last month': '上月', 'This year': '今年',
      'Pageviews': '浏览量', 'Visitors': '访客', 'Unique visitors': '独立访客', 'Sessions': '会话',
      'Pages / visitor': '页/访客', 'Bounce rate (engaged)': '跳出率(参与)', 'Bounce rate (1-page)': '跳出率(单页)',
      'Engaged time': '参与时长', 'Visit duration': '访问时长', 'Human share': '真人占比', 'Forged search': '伪造搜索',
      'Conversions': '转化', 'Revenue': '收入',
      'GA4 engagement metric': 'GA4 参与度指标', 'UA / Plausible style': 'UA / Plausible 口径',
      'Minutes': '分钟', 'Hours': '小时', 'Days': '天', 'Weeks': '周', 'Months': '月',
      'Top sources': '热门来源', 'Pages': '页面', 'Locations': '地区', 'Devices': '设备',
      'Campaigns (UTM)': '广告系列(UTM)', 'Goals (custom events)': '目标(自定义事件)', 'Funnel': '漏斗',
      'Traffic quality': '流量质量', 'Ad protection': '广告防护', 'High-score traffic (drill-down)': '高分流量(下钻)', 'AI report': 'AI 报告',
      'Sources': '来源', 'Countries': '国家/地区', 'Regions': '地区', 'Cities': '城市', 'Browser': '浏览器', 'OS': '操作系统',
      'Device': '设备', 'Size': '屏幕尺寸', 'Entry': '入口页', 'Exit': '出口页', 'Goals': '目标',
      'Campaign': '广告系列', 'Medium': '媒介', 'Term': '关键词', 'Content': '内容',
      'FT source': '首触来源', 'FT medium': '首触媒介', 'FT campaign': '首触广告系列',
      'Visitor': '访客', 'Events': '事件', 'Last seen': '最后活动', 'Where': '位置', 'Agent': '浏览器/系统',
      'Max score': '最高分', 'Verdict': '判定', 'Evidence': '证据', 'Event': '事件', 'Fires': '触发次数',
      'Page path': '页面路径', 'Tier': '档位', 'Block rate': '拦截率', 'Blocked PV': '被拦浏览量',
      'Est. false-positive': '预估误伤率', 'Signal': '信号', 'Block reasons': '拦截原因', 'Top blocked sources': '被拦最多的来源',
      'Generate': '生成', 'Generating…': '生成中…', 'Run': '运行', '+ step': '+ 步骤',
      'Enforce now': '立即启用拦截', 'Clear all': '全部清除', 'All →': '全部 →', 'Mode': '模式',
      'no data yet': '暂无数据', 'no signals fired — traffic looks clean': '未触发任何信号——流量看起来正常',
      'nothing above the threshold — looking clean': '没有超过阈值的——看起来正常',
      'No report yet — click Generate to analyze the selected period.': '还没有报告——点击"生成"分析所选时间段。',
      'generation failed': '生成失败', 'funnel failed': '漏斗计算失败', 'loading…': '加载中…', 'none': '无', '· current': '· 当前',
      'online': '在线', 'human': '真人', '(counted)': '(计入)', '(counted, flagged)': '(计入,已标记)',
      '(excluded)': '(已排除)', '(separate)': '(单独统计)',
      'clean': '正常', 'suspect': '可疑', 'bot': '机器人', 'crawler': '爬虫', 'verified crawler': '已验证爬虫',
      'off': '关闭', 'loose': '宽松', 'balanced': '均衡', 'strict': '严格',
      'counted': '计入', 'Visible dwell, incl. exit page': '可见停留,含离开页', 'PV clean': '干净PV', 'City': '城市', 'Country': '国家/地区', 'Region': '地区', 'Entry page': '入口页', 'Exit page': '出口页', 'First-touch source': '首次触点来源', 'First-touch medium': '首次触点媒介', 'First-touch campaign': '首次触点广告系列', 'Path': '路径', 'Bounces': '跳出', 'Screen': '屏幕', '+ filter': '+ 筛选', 'ads always load — protection disabled': '广告始终加载——防护已关闭', 'load ads only for clean traffic (blocks all suspect + bad)': '仅对正常流量加载广告(拦截所有可疑+恶意)', 'block bots/crawlers always; suspect only without interaction': '始终拦截机器人/爬虫;可疑流量仅在无交互时拦截', 'load ads only for clean traffic that also interacted': '仅对有交互的正常流量加载广告', 'Estimated impact over this period': '本期预估影响', 'pageviews': '次浏览', 'fp-explainer': '"预估误伤率" = 被拦流量中仍有人类交互的占比——视为上限。', 'Blocked/day': '每日拦截', 'saving…': '保存中…', 'save failed': '保存失败', 'saved, applies on next page load': '已保存,下次页面加载生效', 'online now': '在线', 'views': '浏览', 'Language': '语言', 'Recent anomalies (vs baseline)': '近期异常(对比基线)',
    },
    ja: {
      '← sites': '← サイト', 'visitors →': '訪問者 →', 'Search sites…': 'サイトを検索…',
      'Rolling': 'ローリング', 'Calendar': 'カレンダー',
      'Last 24 hours': '過去 24 時間', 'Today': '今日', 'Last 7 days': '過去 7 日間', 'Last 30 days': '過去 30 日間', 'Last 90 days': '過去 90 日間',
      'Yesterday': '昨日', 'This week': '今週', 'Last week': '先週', 'This month': '今月', 'Last month': '先月', 'This year': '今年',
      'Pageviews': 'ページビュー', 'Visitors': '訪問者', 'Unique visitors': 'ユニーク訪問者', 'Sessions': 'セッション',
      'Pages / visitor': 'ページ/訪問者', 'Bounce rate (engaged)': '直帰率（エンゲージ）', 'Bounce rate (1-page)': '直帰率（1ページ）',
      'Engaged time': 'エンゲージ時間', 'Visit duration': '訪問時間', 'Human share': '人間の割合', 'Forged search': '偽装検索',
      'Conversions': 'コンバージョン', 'Revenue': '収益',
      'GA4 engagement metric': 'GA4 エンゲージメント指標', 'UA / Plausible style': 'UA / Plausible 方式',
      'Minutes': '分', 'Hours': '時間', 'Days': '日', 'Weeks': '週', 'Months': '月',
      'Top sources': '参照元トップ', 'Pages': 'ページ', 'Locations': '地域', 'Devices': 'デバイス',
      'Campaigns (UTM)': 'キャンペーン（UTM）', 'Goals (custom events)': '目標（カスタムイベント）', 'Funnel': 'ファネル',
      'Traffic quality': 'トラフィック品質', 'Ad protection': '広告保護', 'High-score traffic (drill-down)': '高スコアのトラフィック（ドリルダウン）', 'AI report': 'AI レポート',
      'Sources': '参照元', 'Countries': '国', 'Regions': '地方', 'Cities': '都市', 'Browser': 'ブラウザ', 'OS': 'OS',
      'Device': 'デバイス', 'Size': '画面サイズ', 'Entry': '入口ページ', 'Exit': '出口ページ', 'Goals': '目標',
      'Campaign': 'キャンペーン', 'Medium': 'メディア', 'Term': 'キーワード', 'Content': 'コンテンツ',
      'FT source': '初回接触の参照元', 'FT medium': '初回接触のメディア', 'FT campaign': '初回接触のキャンペーン',
      'Visitor': '訪問者', 'Events': 'イベント', 'Last seen': '最終アクセス', 'Where': '場所', 'Agent': 'ブラウザ/OS',
      'Max score': '最高スコア', 'Verdict': '判定', 'Evidence': '根拠', 'Event': 'イベント', 'Fires': '発生回数',
      'Page path': 'ページパス', 'Tier': 'ティア', 'Block rate': 'ブロック率', 'Blocked PV': 'ブロックされた PV',
      'Est. false-positive': '推定誤検知率', 'Signal': 'シグナル', 'Block reasons': 'ブロック理由', 'Top blocked sources': 'ブロックされた参照元トップ',
      'Generate': '生成', 'Generating…': '生成中…', 'Run': '実行', '+ step': '+ ステップ',
      'Enforce now': '今すぐ有効化', 'Clear all': 'すべてクリア', 'All →': 'すべて →', 'Mode': 'モード',
      'no data yet': 'データがまだありません', 'no signals fired — traffic looks clean': 'シグナルなし — トラフィックはクリーンです',
      'nothing above the threshold — looking clean': 'しきい値を超えるものはありません — クリーンです',
      'No report yet — click Generate to analyze the selected period.': 'レポートはまだありません — 「生成」をクリックして選択期間を分析します。',
      'generation failed': '生成に失敗しました', 'funnel failed': 'ファネルの計算に失敗しました', 'loading…': '読み込み中…', 'none': 'なし', '· current': '· 現在',
      'online': 'オンライン', 'human': '人間', '(counted)': '（カウント）', '(counted, flagged)': '（カウント・フラグ付き）',
      '(excluded)': '（除外）', '(separate)': '（別集計）',
      'clean': '正常', 'suspect': '疑わしい', 'bot': 'ボット', 'crawler': 'クローラー', 'verified crawler': '確認済みクローラー',
      'off': 'オフ', 'loose': '緩い', 'balanced': 'バランス', 'strict': '厳格',
      'counted': 'カウント', 'Visible dwell, incl. exit page': '可視滞在（離脱ページ含む）', 'PV clean': 'クリーンPV', 'City': '都市', 'Country': '国', 'Region': '地方', 'Entry page': '入口ページ', 'Exit page': '出口ページ', 'First-touch source': '初回接触の参照元', 'First-touch medium': '初回接触のメディア', 'First-touch campaign': '初回接触のキャンペーン', 'Path': 'パス', 'Bounces': '直帰', 'Screen': '画面', '+ filter': '+ フィルター', 'ads always load — protection disabled': '広告は常に読み込まれます — 保護は無効です', 'load ads only for clean traffic (blocks all suspect + bad)': 'クリーンなトラフィックのみ広告を読み込み（疑わしい+不正はすべてブロック）', 'block bots/crawlers always; suspect only without interaction': 'ボット/クローラーは常にブロック、疑わしいものは操作がない場合のみブロック', 'load ads only for clean traffic that also interacted': '操作のあったクリーンなトラフィックのみ広告を読み込み', 'Estimated impact over this period': 'この期間の推定影響', 'pageviews': 'ページビュー', 'fp-explainer': '「推定誤検知率」= ブロックされたトラフィックのうち人間の操作があった割合。上限として扱ってください。', 'Blocked/day': '日次ブロック', 'saving…': '保存中…', 'save failed': '保存に失敗しました', 'saved, applies on next page load': '保存しました。次回のページ読み込みで反映されます', 'online now': 'オンライン', 'views': '閲覧', 'Language': '言語', 'Recent anomalies (vs baseline)': '最近の異常（ベースライン比）',
    },
    ko: {
      '← sites': '← 사이트', 'visitors →': '방문자 →', 'Search sites…': '사이트 검색…',
      'Rolling': '이동 구간', 'Calendar': '달력',
      'Last 24 hours': '지난 24시간', 'Today': '오늘', 'Last 7 days': '지난 7일', 'Last 30 days': '지난 30일', 'Last 90 days': '지난 90일',
      'Yesterday': '어제', 'This week': '이번 주', 'Last week': '지난주', 'This month': '이번 달', 'Last month': '지난달', 'This year': '올해',
      'Pageviews': '페이지뷰', 'Visitors': '방문자', 'Unique visitors': '순 방문자', 'Sessions': '세션',
      'Pages / visitor': '페이지/방문자', 'Bounce rate (engaged)': '이탈률(참여 기준)', 'Bounce rate (1-page)': '이탈률(단일 페이지)',
      'Engaged time': '참여 시간', 'Visit duration': '방문 시간', 'Human share': '실사용자 비율', 'Forged search': '위조 검색',
      'Conversions': '전환', 'Revenue': '수익',
      'GA4 engagement metric': 'GA4 참여 지표', 'UA / Plausible style': 'UA / Plausible 방식',
      'Minutes': '분', 'Hours': '시간', 'Days': '일', 'Weeks': '주', 'Months': '월',
      'Top sources': '상위 소스', 'Pages': '페이지', 'Locations': '위치', 'Devices': '기기',
      'Campaigns (UTM)': '캠페인(UTM)', 'Goals (custom events)': '목표(맞춤 이벤트)', 'Funnel': '퍼널',
      'Traffic quality': '트래픽 품질', 'Ad protection': '광고 보호', 'High-score traffic (drill-down)': '고점수 트래픽(드릴다운)', 'AI report': 'AI 리포트',
      'Sources': '소스', 'Countries': '국가', 'Regions': '지역', 'Cities': '도시', 'Browser': '브라우저', 'OS': '운영체제',
      'Device': '기기', 'Size': '화면 크기', 'Entry': '진입 페이지', 'Exit': '이탈 페이지', 'Goals': '목표',
      'Campaign': '캠페인', 'Medium': '매체', 'Term': '검색어', 'Content': '콘텐츠',
      'FT source': '최초 유입 소스', 'FT medium': '최초 유입 매체', 'FT campaign': '최초 유입 캠페인',
      'Visitor': '방문자', 'Events': '이벤트', 'Last seen': '마지막 활동', 'Where': '위치', 'Agent': '브라우저/OS',
      'Max score': '최고 점수', 'Verdict': '판정', 'Evidence': '증거', 'Event': '이벤트', 'Fires': '발생 횟수',
      'Page path': '페이지 경로', 'Tier': '등급', 'Block rate': '차단율', 'Blocked PV': '차단된 PV',
      'Est. false-positive': '예상 오탐률', 'Signal': '신호', 'Block reasons': '차단 사유', 'Top blocked sources': '가장 많이 차단된 소스',
      'Generate': '생성', 'Generating…': '생성 중…', 'Run': '실행', '+ step': '+ 단계',
      'Enforce now': '지금 적용', 'Clear all': '모두 지우기', 'All →': '전체 →', 'Mode': '모드',
      'no data yet': '아직 데이터 없음', 'no signals fired — traffic looks clean': '발생한 신호 없음 — 트래픽이 정상입니다',
      'nothing above the threshold — looking clean': '임계값을 넘는 항목 없음 — 정상입니다',
      'No report yet — click Generate to analyze the selected period.': '아직 리포트가 없습니다 — \'생성\'을 클릭해 선택한 기간을 분석하세요.',
      'generation failed': '생성 실패', 'funnel failed': '퍼널 계산 실패', 'loading…': '불러오는 중…', 'none': '없음', '· current': '· 현재',
      'online': '온라인', 'human': '실사용자', '(counted)': '(집계됨)', '(counted, flagged)': '(집계, 플래그됨)',
      '(excluded)': '(제외됨)', '(separate)': '(별도 집계)',
      'clean': '정상', 'suspect': '의심', 'bot': '봇', 'crawler': '크롤러', 'verified crawler': '검증된 크롤러',
      'off': '끄기', 'loose': '느슨', 'balanced': '균형', 'strict': '엄격',
      'counted': '집계', 'Visible dwell, incl. exit page': '표시 체류(이탈 페이지 포함)', 'PV clean': '정상 PV', 'City': '도시', 'Country': '국가', 'Region': '지역', 'Entry page': '진입 페이지', 'Exit page': '이탈 페이지', 'First-touch source': '최초 유입 소스', 'First-touch medium': '최초 유입 매체', 'First-touch campaign': '최초 유입 캠페인', 'Path': '경로', 'Bounces': '이탈', 'Screen': '화면', '+ filter': '+ 필터', 'ads always load — protection disabled': '광고가 항상 로드됨 — 보호 비활성화', 'load ads only for clean traffic (blocks all suspect + bad)': '정상 트래픽에만 광고 로드(의심+악성 모두 차단)', 'block bots/crawlers always; suspect only without interaction': '봇/크롤러는 항상 차단, 의심 트래픽은 상호작용이 없을 때만 차단', 'load ads only for clean traffic that also interacted': '상호작용한 정상 트래픽에만 광고 로드', 'Estimated impact over this period': '이 기간의 예상 영향', 'pageviews': '페이지뷰', 'fp-explainer': '"예상 오탐률" = 차단된 트래픽 중 인간 상호작용이 있었던 비율 — 상한선으로 간주하세요.', 'Blocked/day': '일일 차단', 'saving…': '저장 중…', 'save failed': '저장 실패', 'saved, applies on next page load': '저장됨, 다음 페이지 로드 시 적용', 'online now': '온라인', 'views': '조회', 'Language': '언어', 'Recent anomalies (vs baseline)': '최근 이상(기준선 대비)',
    },
    de: {
      '← sites': '← Websites', 'visitors →': 'Besucher →', 'Search sites…': 'Websites suchen…',
      'Rolling': 'Gleitend', 'Calendar': 'Kalender',
      'Last 24 hours': 'Letzte 24 Stunden', 'Today': 'Heute', 'Last 7 days': 'Letzte 7 Tage', 'Last 30 days': 'Letzte 30 Tage', 'Last 90 days': 'Letzte 90 Tage',
      'Yesterday': 'Gestern', 'This week': 'Diese Woche', 'Last week': 'Letzte Woche', 'This month': 'Dieser Monat', 'Last month': 'Letzter Monat', 'This year': 'Dieses Jahr',
      'Pageviews': 'Seitenaufrufe', 'Visitors': 'Besucher', 'Unique visitors': 'Eindeutige Besucher', 'Sessions': 'Sitzungen',
      'Pages / visitor': 'Seiten/Besucher', 'Bounce rate (engaged)': 'Absprungrate (Engagement)', 'Bounce rate (1-page)': 'Absprungrate (1 Seite)',
      'Engaged time': 'Aktive Zeit', 'Visit duration': 'Besuchsdauer', 'Human share': 'Anteil echter Nutzer', 'Forged search': 'Gefälschte Suche',
      'Conversions': 'Conversions', 'Revenue': 'Umsatz',
      'GA4 engagement metric': 'GA4-Engagement-Metrik', 'UA / Plausible style': 'UA-/Plausible-Stil',
      'Minutes': 'Minuten', 'Hours': 'Stunden', 'Days': 'Tage', 'Weeks': 'Wochen', 'Months': 'Monate',
      'Top sources': 'Top-Quellen', 'Pages': 'Seiten', 'Locations': 'Standorte', 'Devices': 'Geräte',
      'Campaigns (UTM)': 'Kampagnen (UTM)', 'Goals (custom events)': 'Ziele (benutzerdefinierte Ereignisse)', 'Funnel': 'Trichter',
      'Traffic quality': 'Traffic-Qualität', 'Ad protection': 'Anzeigenschutz', 'High-score traffic (drill-down)': 'Traffic mit hoher Bewertung (Detailansicht)', 'AI report': 'KI-Bericht',
      'Sources': 'Quellen', 'Countries': 'Länder', 'Regions': 'Regionen', 'Cities': 'Städte', 'Browser': 'Browser', 'OS': 'Betriebssystem',
      'Device': 'Gerät', 'Size': 'Bildschirmgröße', 'Entry': 'Einstieg', 'Exit': 'Ausstieg', 'Goals': 'Ziele',
      'Campaign': 'Kampagne', 'Medium': 'Medium', 'Term': 'Suchbegriff', 'Content': 'Inhalt',
      'FT source': 'Erstkontakt-Quelle', 'FT medium': 'Erstkontakt-Medium', 'FT campaign': 'Erstkontakt-Kampagne',
      'Visitor': 'Besucher', 'Events': 'Ereignisse', 'Last seen': 'Zuletzt gesehen', 'Where': 'Wo', 'Agent': 'Browser/OS',
      'Max score': 'Höchstwert', 'Verdict': 'Urteil', 'Evidence': 'Belege', 'Event': 'Ereignis', 'Fires': 'Auslösungen',
      'Page path': 'Seitenpfad', 'Tier': 'Stufe', 'Block rate': 'Blockrate', 'Blocked PV': 'Blockierte PV',
      'Est. false-positive': 'Gesch. Fehlalarm', 'Signal': 'Signal', 'Block reasons': 'Blockgründe', 'Top blocked sources': 'Meistblockierte Quellen',
      'Generate': 'Erstellen', 'Generating…': 'Wird erstellt…', 'Run': 'Ausführen', '+ step': '+ Schritt',
      'Enforce now': 'Jetzt durchsetzen', 'Clear all': 'Alle löschen', 'All →': 'Alle →', 'Mode': 'Modus',
      'no data yet': 'Noch keine Daten', 'no signals fired — traffic looks clean': 'Keine Signale ausgelöst – Traffic wirkt sauber',
      'nothing above the threshold — looking clean': 'Nichts über dem Schwellenwert – wirkt sauber',
      'No report yet — click Generate to analyze the selected period.': 'Noch kein Bericht – auf „Erstellen" klicken, um den Zeitraum zu analysieren.',
      'generation failed': 'Erstellung fehlgeschlagen', 'funnel failed': 'Trichter fehlgeschlagen', 'loading…': 'Wird geladen…', 'none': 'Keine', '· current': '· aktuell',
      'online': 'online', 'human': 'Mensch', '(counted)': '(gezählt)', '(counted, flagged)': '(gezählt, markiert)',
      '(excluded)': '(ausgeschlossen)', '(separate)': '(getrennt)',
      'clean': 'sauber', 'suspect': 'verdächtig', 'bot': 'Bot', 'crawler': 'Crawler', 'verified crawler': 'verifizierter Crawler',
      'off': 'aus', 'loose': 'locker', 'balanced': 'ausgewogen', 'strict': 'streng',
      'counted': 'gezählt', 'Visible dwell, incl. exit page': 'Sichtbare Verweildauer (inkl. Ausstiegsseite)', 'PV clean': 'Saubere PV', 'City': 'Stadt', 'Country': 'Land', 'Region': 'Region', 'Entry page': 'Einstiegsseite', 'Exit page': 'Ausstiegsseite', 'First-touch source': 'Erstkontakt-Quelle', 'First-touch medium': 'Erstkontakt-Medium', 'First-touch campaign': 'Erstkontakt-Kampagne', 'Path': 'Pfad', 'Bounces': 'Absprünge', 'Screen': 'Bildschirm', '+ filter': '+ Filter', 'ads always load — protection disabled': 'Anzeigen laden immer – Schutz deaktiviert', 'load ads only for clean traffic (blocks all suspect + bad)': 'Anzeigen nur für sauberen Traffic laden (blockiert alle verdächtigen + schlechten)', 'block bots/crawlers always; suspect only without interaction': 'Bots/Crawler immer blockieren; verdächtige nur ohne Interaktion', 'load ads only for clean traffic that also interacted': 'Anzeigen nur für sauberen Traffic mit Interaktion laden', 'Estimated impact over this period': 'Geschätzte Auswirkung in diesem Zeitraum', 'pageviews': 'Seitenaufrufe', 'fp-explainer': '„Gesch. Fehlalarm" = Anteil des blockierten Traffics, der dennoch menschliche Interaktion zeigte – als Obergrenze verstehen.', 'Blocked/day': 'Blockiert/Tag', 'saving…': 'Wird gespeichert…', 'save failed': 'Speichern fehlgeschlagen', 'saved, applies on next page load': 'gespeichert, gilt beim nächsten Seitenaufruf', 'online now': 'online', 'views': 'Aufrufe', 'Language': 'Sprache', 'Recent anomalies (vs baseline)': 'Aktuelle Anomalien (ggü. Basislinie)',
    },
    fr: {
      '← sites': '← Sites', 'visitors →': 'Visiteurs →', 'Search sites…': 'Rechercher des sites…',
      'Rolling': 'Glissant', 'Calendar': 'Calendrier',
      'Last 24 hours': 'Dernières 24 heures', 'Today': "Aujourd'hui", 'Last 7 days': '7 derniers jours', 'Last 30 days': '30 derniers jours', 'Last 90 days': '90 derniers jours',
      'Yesterday': 'Hier', 'This week': 'Cette semaine', 'Last week': 'La semaine dernière', 'This month': 'Ce mois-ci', 'Last month': 'Le mois dernier', 'This year': 'Cette année',
      'Pageviews': 'Pages vues', 'Visitors': 'Visiteurs', 'Unique visitors': 'Visiteurs uniques', 'Sessions': 'Sessions',
      'Pages / visitor': 'Pages/visiteur', 'Bounce rate (engaged)': 'Taux de rebond (engagé)', 'Bounce rate (1-page)': 'Taux de rebond (1 page)',
      'Engaged time': "Temps d'engagement", 'Visit duration': 'Durée de visite', 'Human share': "Part d'humains", 'Forged search': 'Recherche falsifiée',
      'Conversions': 'Conversions', 'Revenue': 'Revenus',
      'GA4 engagement metric': "Métrique d'engagement GA4", 'UA / Plausible style': 'Style UA / Plausible',
      'Minutes': 'Minutes', 'Hours': 'Heures', 'Days': 'Jours', 'Weeks': 'Semaines', 'Months': 'Mois',
      'Top sources': 'Sources principales', 'Pages': 'Pages', 'Locations': 'Emplacements', 'Devices': 'Appareils',
      'Campaigns (UTM)': 'Campagnes (UTM)', 'Goals (custom events)': 'Objectifs (événements personnalisés)', 'Funnel': 'Entonnoir',
      'Traffic quality': 'Qualité du trafic', 'Ad protection': 'Protection des annonces', 'High-score traffic (drill-down)': 'Trafic à score élevé (exploration)', 'AI report': 'Rapport IA',
      'Sources': 'Sources', 'Countries': 'Pays', 'Regions': 'Régions', 'Cities': 'Villes', 'Browser': 'Navigateur', 'OS': 'OS',
      'Device': 'Appareil', 'Size': "Taille d'écran", 'Entry': 'Entrée', 'Exit': 'Sortie', 'Goals': 'Objectifs',
      'Campaign': 'Campagne', 'Medium': 'Support', 'Term': 'Terme', 'Content': 'Contenu',
      'FT source': 'Source premier contact', 'FT medium': 'Support premier contact', 'FT campaign': 'Campagne premier contact',
      'Visitor': 'Visiteur', 'Events': 'Événements', 'Last seen': 'Vu la dernière fois', 'Where': 'Où', 'Agent': 'Navigateur/OS',
      'Max score': 'Score max', 'Verdict': 'Verdict', 'Evidence': 'Preuves', 'Event': 'Événement', 'Fires': 'Déclenchements',
      'Page path': 'Chemin de page', 'Tier': 'Niveau', 'Block rate': 'Taux de blocage', 'Blocked PV': 'PV bloquées',
      'Est. false-positive': 'Faux positifs est.', 'Signal': 'Signal', 'Block reasons': 'Motifs de blocage', 'Top blocked sources': 'Sources les plus bloquées',
      'Generate': 'Générer', 'Generating…': 'Génération…', 'Run': 'Exécuter', '+ step': '+ étape',
      'Enforce now': 'Appliquer maintenant', 'Clear all': 'Tout effacer', 'All →': 'Tout →', 'Mode': 'Mode',
      'no data yet': 'Pas encore de données', 'no signals fired — traffic looks clean': 'Aucun signal déclenché — le trafic semble sain',
      'nothing above the threshold — looking clean': 'Rien au-dessus du seuil — semble sain',
      'No report yet — click Generate to analyze the selected period.': 'Pas encore de rapport — cliquez sur « Générer » pour analyser la période.',
      'generation failed': 'Échec de la génération', 'funnel failed': "Échec de l'entonnoir", 'loading…': 'Chargement…', 'none': 'Aucun', '· current': '· actuel',
      'online': 'en ligne', 'human': 'humain', '(counted)': '(compté)', '(counted, flagged)': '(compté, signalé)',
      '(excluded)': '(exclu)', '(separate)': '(séparé)',
      'clean': 'propre', 'suspect': 'suspect', 'bot': 'bot', 'crawler': 'robot', 'verified crawler': 'robot vérifié',
      'off': 'désactivé', 'loose': 'souple', 'balanced': 'équilibré', 'strict': 'strict',
      'counted': 'comptés', 'Visible dwell, incl. exit page': 'Temps visible (page de sortie incl.)', 'PV clean': 'PV propres', 'City': 'Ville', 'Country': 'Pays', 'Region': 'Région', 'Entry page': 'Page d\'entrée', 'Exit page': 'Page de sortie', 'First-touch source': 'Source premier contact', 'First-touch medium': 'Support premier contact', 'First-touch campaign': 'Campagne premier contact', 'Path': 'Chemin', 'Bounces': 'Rebonds', 'Screen': 'Écran', '+ filter': '+ filtre', 'ads always load — protection disabled': 'les annonces se chargent toujours — protection désactivée', 'load ads only for clean traffic (blocks all suspect + bad)': 'charger les annonces uniquement pour le trafic sain (bloque tout suspect + mauvais)', 'block bots/crawlers always; suspect only without interaction': 'bloquer toujours les bots/robots ; suspects seulement sans interaction', 'load ads only for clean traffic that also interacted': 'charger les annonces uniquement pour le trafic sain ayant interagi', 'Estimated impact over this period': 'Impact estimé sur cette période', 'pageviews': 'pages vues', 'fp-explainer': '« Faux positifs est. » = part du trafic bloqué ayant tout de même montré une interaction humaine — à considérer comme une borne supérieure.', 'Blocked/day': 'Bloqué/jour', 'saving…': 'Enregistrement…', 'save failed': 'Échec de l\'enregistrement', 'saved, applies on next page load': 'enregistré, appliqué au prochain chargement', 'online now': 'en ligne', 'views': 'vues', 'Language': 'Langue', 'Recent anomalies (vs baseline)': 'Anomalies récentes (vs référence)',
    },
    es: {
      '← sites': '← Sitios', 'visitors →': 'Visitantes →', 'Search sites…': 'Buscar sitios…',
      'Rolling': 'Móvil', 'Calendar': 'Calendario',
      'Last 24 hours': 'Últimas 24 horas', 'Today': 'Hoy', 'Last 7 days': 'Últimos 7 días', 'Last 30 days': 'Últimos 30 días', 'Last 90 days': 'Últimos 90 días',
      'Yesterday': 'Ayer', 'This week': 'Esta semana', 'Last week': 'La semana pasada', 'This month': 'Este mes', 'Last month': 'El mes pasado', 'This year': 'Este año',
      'Pageviews': 'Páginas vistas', 'Visitors': 'Visitantes', 'Unique visitors': 'Visitantes únicos', 'Sessions': 'Sesiones',
      'Pages / visitor': 'Páginas/visitante', 'Bounce rate (engaged)': 'Tasa de rebote (interacción)', 'Bounce rate (1-page)': 'Tasa de rebote (1 página)',
      'Engaged time': 'Tiempo de interacción', 'Visit duration': 'Duración de la visita', 'Human share': 'Proporción de humanos', 'Forged search': 'Búsqueda falsificada',
      'Conversions': 'Conversiones', 'Revenue': 'Ingresos',
      'GA4 engagement metric': 'Métrica de interacción de GA4', 'UA / Plausible style': 'Estilo UA / Plausible',
      'Minutes': 'Minutos', 'Hours': 'Horas', 'Days': 'Días', 'Weeks': 'Semanas', 'Months': 'Meses',
      'Top sources': 'Fuentes principales', 'Pages': 'Páginas', 'Locations': 'Ubicaciones', 'Devices': 'Dispositivos',
      'Campaigns (UTM)': 'Campañas (UTM)', 'Goals (custom events)': 'Objetivos (eventos personalizados)', 'Funnel': 'Embudo',
      'Traffic quality': 'Calidad del tráfico', 'Ad protection': 'Protección de anuncios', 'High-score traffic (drill-down)': 'Tráfico de alta puntuación (desglose)', 'AI report': 'Informe de IA',
      'Sources': 'Fuentes', 'Countries': 'Países', 'Regions': 'Regiones', 'Cities': 'Ciudades', 'Browser': 'Navegador', 'OS': 'SO',
      'Device': 'Dispositivo', 'Size': 'Tamaño de pantalla', 'Entry': 'Entrada', 'Exit': 'Salida', 'Goals': 'Objetivos',
      'Campaign': 'Campaña', 'Medium': 'Medio', 'Term': 'Término', 'Content': 'Contenido',
      'FT source': 'Fuente de primer contacto', 'FT medium': 'Medio de primer contacto', 'FT campaign': 'Campaña de primer contacto',
      'Visitor': 'Visitante', 'Events': 'Eventos', 'Last seen': 'Visto por última vez', 'Where': 'Dónde', 'Agent': 'Navegador/SO',
      'Max score': 'Puntuación máx.', 'Verdict': 'Veredicto', 'Evidence': 'Evidencia', 'Event': 'Evento', 'Fires': 'Activaciones',
      'Page path': 'Ruta de página', 'Tier': 'Nivel', 'Block rate': 'Tasa de bloqueo', 'Blocked PV': 'PV bloqueadas',
      'Est. false-positive': 'Falsos positivos est.', 'Signal': 'Señal', 'Block reasons': 'Motivos de bloqueo', 'Top blocked sources': 'Fuentes más bloqueadas',
      'Generate': 'Generar', 'Generating…': 'Generando…', 'Run': 'Ejecutar', '+ step': '+ paso',
      'Enforce now': 'Aplicar ahora', 'Clear all': 'Borrar todo', 'All →': 'Todo →', 'Mode': 'Modo',
      'no data yet': 'Aún no hay datos', 'no signals fired — traffic looks clean': 'Ningún indicador activado — el tráfico parece limpio',
      'nothing above the threshold — looking clean': 'Nada por encima del umbral — parece limpio',
      'No report yet — click Generate to analyze the selected period.': 'Aún no hay informe — haz clic en «Generar» para analizar el periodo.',
      'generation failed': 'Error al generar', 'funnel failed': 'El embudo falló', 'loading…': 'Cargando…', 'none': 'Ninguno', '· current': '· actual',
      'online': 'en línea', 'human': 'humano', '(counted)': '(contado)', '(counted, flagged)': '(contado, marcado)',
      '(excluded)': '(excluido)', '(separate)': '(por separado)',
      'clean': 'limpio', 'suspect': 'sospechoso', 'bot': 'bot', 'crawler': 'rastreador', 'verified crawler': 'rastreador verificado',
      'off': 'desactivado', 'loose': 'flexible', 'balanced': 'equilibrado', 'strict': 'estricto',
      'counted': 'contados', 'Visible dwell, incl. exit page': 'Permanencia visible (incl. página de salida)', 'PV clean': 'PV limpias', 'City': 'Ciudad', 'Country': 'País', 'Region': 'Región', 'Entry page': 'Página de entrada', 'Exit page': 'Página de salida', 'First-touch source': 'Fuente de primer contacto', 'First-touch medium': 'Medio de primer contacto', 'First-touch campaign': 'Campaña de primer contacto', 'Path': 'Ruta', 'Bounces': 'Rebotes', 'Screen': 'Pantalla', '+ filter': '+ filtro', 'ads always load — protection disabled': 'los anuncios siempre se cargan — protección desactivada', 'load ads only for clean traffic (blocks all suspect + bad)': 'cargar anuncios solo para tráfico limpio (bloquea todo lo sospechoso + malo)', 'block bots/crawlers always; suspect only without interaction': 'bloquear siempre bots/rastreadores; sospechosos solo sin interacción', 'load ads only for clean traffic that also interacted': 'cargar anuncios solo para tráfico limpio que además interactuó', 'Estimated impact over this period': 'Impacto estimado en este periodo', 'pageviews': 'páginas vistas', 'fp-explainer': '«Falsos positivos est.» = proporción del tráfico bloqueado que aun así mostró interacción humana — considérelo un límite superior.', 'Blocked/day': 'Bloqueado/día', 'saving…': 'Guardando…', 'save failed': 'Error al guardar', 'saved, applies on next page load': 'guardado, se aplica en la próxima carga', 'online now': 'en línea', 'views': 'vistas', 'Language': 'Idioma', 'Recent anomalies (vs baseline)': 'Anomalías recientes (vs. referencia)',
    },
  };

  var STORAGE_KEY = 'pvuv.lang';
  function pickInitial() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && (saved === 'en' || DICT[saved])) return saved;
    } catch (e) { /* storage blocked */ }
    var nav = (navigator.language || 'en').toLowerCase();
    for (var i = 0; i < LANGS.length; i++) {
      if (nav === LANGS[i].code || nav.indexOf(LANGS[i].code + '-') === 0) return LANGS[i].code;
    }
    return 'en';
  }

  var lang = pickInitial();

  function t(s) {
    if (s == null) return s;
    if (lang === 'en') return s;
    var d = DICT[lang];
    return (d && d[s] != null) ? d[s] : s;
  }

  /** Translate any element with data-i18n (textContent), data-i18n-ph
   *  (placeholder) or data-i18n-title (title + aria-label). */
  function applyStatic(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var v = t(el.getAttribute('data-i18n-title'));
      el.setAttribute('title', v);
      el.setAttribute('aria-label', v);
    });
    root.querySelectorAll('[data-i18n-label]').forEach(function (el) {
      el.setAttribute('label', t(el.getAttribute('data-i18n-label'))); // <optgroup label>
    });
  }

  function setLang(code) {
    if (code !== 'en' && !DICT[code]) return;
    lang = code;
    try { localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* ignore */ }
    document.documentElement.setAttribute('lang', code);
    applyStatic(document);
    document.dispatchEvent(new CustomEvent('pvuv:lang', { detail: { lang: code } }));
  }

  /** Populate a <select> with the language list and wire it to setLang. */
  function mountSelect(el) {
    if (!el) return;
    el.innerHTML = LANGS.map(function (l) {
      return '<option value="' + l.code + '"' + (l.code === lang ? ' selected' : '') + '>' + l.label + '</option>';
    }).join('');
    el.value = lang;
    el.addEventListener('change', function () { setLang(el.value); });
  }

  window.PVI18N = {
    t: t, setLang: setLang, applyStatic: applyStatic, mountSelect: mountSelect, langs: LANGS,
    get lang() { return lang; },
  };
  document.documentElement.setAttribute('lang', lang);
})();
