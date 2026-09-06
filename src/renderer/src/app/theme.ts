/**
 * Ant Design theme derived from the Organic design tokens in styles.css.
 *
 * The screens are hand-built from the design-system classes (.btn, .input,
 * .table, .jp-panel); antd still supplies the heavy interactive parts —
 * Select, DatePicker, Modal, message. This maps the same palette onto those so
 * the two never disagree.
 *
 * Values are literal hex rather than `var(--color-…)` because antd computes
 * derived colours (hover, active, disabled) from them at runtime, which it
 * cannot do through a CSS custom property.
 */
import type { ThemeConfig } from 'antd';

/** Mirrors of the CSS custom properties. Keep in sync with styles.css. */
export const tokens = {
  bg: '#f5ead8',
  surface: '#ebddc5',
  text: '#201e1d',
  accent: '#c67139',
  accent2: '#7a8a5e',

  neutral100: '#f9f4ed',
  neutral200: '#eee7db',
  neutral300: '#dcd3c4',
  neutral400: '#c0b6a5',
  neutral500: '#a19786',
  neutral600: '#82796a',
  neutral700: '#645c50',
  neutral800: '#474238',
  neutral900: '#2e2b25',

  accent100: '#fff2eb',
  accent300: '#ffc6a5',
  accent400: '#f6a06b',
  accent600: '#b2622d',
  accent700: '#8c491a',
  accent800: '#643312',
  accent900: '#402310',

  accent2_100: '#f0fae1',
  accent2_500: '#8fa073',
  accent2_700: '#56633f',
  accent2_800: '#3d472b',

  // Kept in step with --font-heading / --font-body / --font-mono in styles.css:
  // antd surfaces and the hand-rolled ones must not drift apart.
  fontHeading: "'Lora', Georgia, 'Times New Roman', serif",
  fontBody: "'Poppins', system-ui, sans-serif",
  // antd renders the dense surfaces — tables, selects, form fields — so it
  // follows the reading face, not the brand face. See --font-ui in styles.css.
  fontUi: "system-ui, 'Segoe UI', -apple-system, sans-serif",
  fontMono: "'DejaVu Sans Mono', ui-monospace, Consolas, monospace",
} as const;

/** Shell chrome — the flattened equivalents of the --jp-ink / --jp-desk mixes.
 * color-mix() is fine in CSS but antd needs plain colours. */
export const INK = '#2f2018';
export const DESK = '#d9cdb8';

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: tokens.accent,
    colorInfo: tokens.accent,
    colorSuccess: tokens.accent2,
    colorWarning: tokens.accent600,
    colorError: '#a4381f',

    colorTextBase: tokens.text,
    colorBgBase: tokens.bg,
    colorBgContainer: tokens.bg,
    colorBgElevated: tokens.surface,
    colorBorder: tokens.neutral300,
    colorBorderSecondary: tokens.neutral200,

    fontFamily: tokens.fontUi,
    fontSize: 14,

    borderRadius: 16,
    borderRadiusLG: 24,
    borderRadiusSM: 10,

    boxShadow: '0 3px 10px rgba(46, 43, 37, 0.16)',
    boxShadowSecondary: '0 12px 32px rgba(46, 43, 37, 0.22)',

    controlHeight: 36,

    // antd animates by default; these pin its timing to the --dur/--ease
    // tokens in styles.css so the hand-rolled controls and the antd ones feel
    // like one system rather than two.
    motionUnit: 0.06,
    motionBase: 0,
    motionEaseInOut: 'cubic-bezier(0.2, 0, 0, 1)',
    motionEaseOut: 'cubic-bezier(0.2, 0, 0, 1)',
  },
  components: {
    Button: {
      // Poppins at 400 reads thin on a filled button; 500 matches the weight
      // the rest of the UI settles on without tipping into shouty.
      fontWeight: 500,
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
      borderRadius: 999,
      borderRadiusLG: 999,
      borderRadiusSM: 999,
      colorTextLightSolid: tokens.bg,
    },
    Input: {
      colorBgContainer: tokens.surface,
      borderRadius: 999,
      borderRadiusLG: 999,
      borderRadiusSM: 999,
      paddingInline: 14,
      activeShadow: 'none',
    },
    InputNumber: {
      colorBgContainer: tokens.surface,
      borderRadius: 999,
      borderRadiusLG: 999,
      borderRadiusSM: 999,
      paddingInline: 14,
      activeShadow: 'none',
    },
    Select: {
      colorBgContainer: tokens.surface,
      borderRadius: 999,
      borderRadiusLG: 999,
      borderRadiusSM: 999,
      optionSelectedBg: tokens.accent100,
      optionSelectedColor: tokens.accent800,
      optionActiveBg: tokens.neutral200,
    },
    DatePicker: {
      colorBgContainer: tokens.surface,
      borderRadius: 999,
      activeShadow: 'none',
    },
    Table: {
      headerBg: 'transparent',
      headerColor: tokens.neutral700,
      headerSplitColor: 'transparent',
      borderColor: tokens.neutral300,
      rowHoverBg: tokens.neutral200,
      colorBgContainer: 'transparent',
      cellPaddingBlock: 9,
      cellPaddingInline: 9,
    },
    Card: {
      colorBgContainer: tokens.surface,
      borderRadiusLG: 24,
      paddingLG: 20,
      boxShadowTertiary: 'none',
    },
    Modal: {
      contentBg: tokens.surface,
      headerBg: tokens.surface,
      borderRadiusLG: 28,
      titleFontSize: 20,
    },
    Segmented: {
      itemSelectedBg: tokens.accent,
      itemSelectedColor: tokens.bg,
      trackBg: tokens.surface,
      borderRadius: 999,
      borderRadiusSM: 999,
    },
    Tag: {
      defaultBg: tokens.neutral100,
      defaultColor: tokens.neutral800,
      borderRadiusSM: 999,
    },
    Statistic: {
      contentFontSize: 26,
      titleFontSize: 11,
    },
    Menu: {
      itemSelectedBg: tokens.accent,
      itemSelectedColor: tokens.bg,
      itemBorderRadius: 14,
      itemHeight: 40,
    },
    Layout: {
      bodyBg: tokens.bg,
      headerBg: INK,
      siderBg: tokens.accent900,
    },
    Alert: {
      colorInfoBg: tokens.accent100,
      colorInfoBorder: tokens.accent300,
      colorWarningBg: tokens.accent100,
      colorWarningBorder: tokens.accent300,
      borderRadiusLG: 18,
    },
    Message: {
      contentBg: INK,
      colorText: tokens.bg,
    },
    Tooltip: {
      colorBgSpotlight: INK,
      colorTextLightSolid: tokens.bg,
      borderRadius: 12,
    },
    Spin: {
      colorPrimary: tokens.accent,
    },
    Form: {
      labelColor: tokens.neutral700,
      labelFontSize: 12,
      verticalLabelPadding: '0 0 5px',
    },
  },
};
