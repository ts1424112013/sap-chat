# Lyux 组件设计评审

采用 design-taste-frontend 的组件预览流程，延续用户确认的自然感与动态需求；无需对已有比较工具重新抽取营销页面风格。图形直接用 SVG 制作，便于拆分部件、自然运动和小尺寸复用。

ROUND 1
Seen in one second: 三个 Lyux 方向，柔和蓝青色与芽绿。
Idea (one sentence): 回应成为两笔曲线的靠近、软耳朵的侧倾、小芽的舒展。
Live thing: 三态切换、暂停、自动演示、背景切换、当前状态下载。
Layout words by section: header=操作台 / comparison=三方案并列 / footer=动态说明。
Scores: design 6 · usability 6.5 · creativity 7 · content 8 → overall 6.5。
Caps applied: 第一轮桌面继承了四方案紧凑展示的高度规则，字标与说明过近；需修正。
Top fixes: 清除旧的桌面高度覆盖，让图形、字标、说明各有独立空间。

ROUND 2
Seen in one second: 三种轮廓和完整的 Lyux 字标。
Idea (one sentence): 品牌以轻微、不同节奏的部件运动回应用户。
Live thing: 三款九种动态已实测；暂停与自动切换正常；动态 SVG 实际下载成功。
Layout words by section: header=操作台 / comparison=三方案并列 / footer=动态说明。
Scores: design 7.6 · usability 8.2 · creativity 7.2 · content 8 → overall 7.7。
Caps applied: 无失败项。保留一条 panel-void 提示：三款标志周围有等量展示留白，用于观察轮廓和运动边界；这是标志安全空间，不是缺失内容。
Fixes made: 清除冲突的高度规则；浏览器测量确认字标底边与说明顶部有独立间隔；逐一检查桌面、平板、手机、深色底截图。
Remaining tradeoff: 「小灵」偏陪伴气质；「回声」更抽象；「月芽」更简洁，需要与字标长期搭配建立识别。16px 主要依靠轮廓识别，不依赖眼睛和微小表情。
