// Voice Studio · 网页半边：侧边栏「音色工坊」入口 + 整页面板（内嵌 /voice-studio/app）。
window.__ModuleLoader__.load({
  id: 'dsh-voice-studio',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    const PANEL_ID = 'voice-studio'

    function StudioPage() {
      return h(
        'div',
        { style: { height: '100%', display: 'flex', flexDirection: 'column', background: '#0f1218' } },
        h(
          'div',
          { style: { padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: '1px solid #242c3a' } },
          h('b', { style: { fontSize: 14 } }, '音色工坊'),
          h('span', { style: { color: '#8895a7', fontSize: 12 } }, '本地 GPT-SoVITS · 训练 / 试听 / 切换'),
          h('a', { href: '/voice-studio/app', target: '_blank', rel: 'noreferrer', style: { marginLeft: 'auto', color: '#7aa2f7', fontSize: 12 } }, '在新窗口打开 ↗'),
        ),
        h('iframe', {
          src: '/voice-studio/app?_=' + Date.now(),
          title: 'Voice Studio',
          style: { flex: 1, border: 0, width: '100%', background: '#0f1218' },
        }),
      )
    }

    function StudioIcon() {
      return h('span', { style: { fontSize: 16, lineHeight: 1 } }, '🎚')
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, StudioPage))
      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 21, label: () => '音色工坊' }, StudioIcon),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.StudioPage = StudioPage
    return module.exports
  },
})
