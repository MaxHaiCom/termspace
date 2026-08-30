/* 统一图标：14px 线性描边，SF Symbols 气质，无外部依赖 */
const S = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

export const IconTerminal = (): React.JSX.Element => (
  <svg {...S}>
    <path d="M4 17l6-5-6-5M12 19h8" />
  </svg>
)

export const IconAgent = (): React.JSX.Element => (
  <svg {...S}>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 8V4M9 14h.01M15 14h.01M2 13v2M22 13v2" />
  </svg>
)

export const IconBrief = (): React.JSX.Element => (
  <svg {...S}>
    <path d="M5 4h11l4 4v12a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z" />
    <path d="M15 4v5h5M8 13h8M8 17h5" />
  </svg>
)

export const IconFit = (): React.JSX.Element => (
  <svg {...S}>
    <path d="M4 9V5a1 1 0 011-1h4M15 4h4a1 1 0 011 1v4M20 15v4a1 1 0 01-1 1h-4M9 20H5a1 1 0 01-1-1v-4" />
  </svg>
)

export const IconKey = (): React.JSX.Element => (
  <svg {...S}>
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2L20 3l1.5 1.5M17 6l1.8 1.8" />
  </svg>
)

export const IconSettings = (): React.JSX.Element => (
  <svg {...S}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.6 1.6 0 008 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H2a2 2 0 110-4h.1A1.6 1.6 0 004.6 8a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V2a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H22a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" />
  </svg>
)

export const IconGroup = (): React.JSX.Element => (
  <svg {...S}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
)

export const IconPlus = (): React.JSX.Element => (
  <svg {...S}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconChevron = (): React.JSX.Element => (
  <svg {...S} width={10} height={10}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)

export const IconGlobe = (): React.JSX.Element => (
  <svg {...S}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z" />
  </svg>
)

export const IconHand = (): React.JSX.Element => (
  <svg {...S} width={15} height={15}>
    <path d="M18 11V6a1.5 1.5 0 00-3 0m0 0V4.5a1.5 1.5 0 00-3 0V11m3-5v5m-3-6.5a1.5 1.5 0 00-3 0V12m0-4a1.5 1.5 0 00-3 0v5.5c0 3 2.5 5.5 5.5 5.5S18 21.5 18 18.5V11" />
  </svg>
)

export const IconCursor = (): React.JSX.Element => (
  <svg {...S} width={15} height={15}>
    <path d="M5 3l7 18 2.5-7L21 11.5 5 3z" />
  </svg>
)

/** 缩放控件栈用。和 IconPlus 同一套线宽 —— 它们现在同处一个容器 */
export const IconMinus = (): React.JSX.Element => (
  <svg {...S}>
    <path d="M5 12h14" />
  </svg>
)
