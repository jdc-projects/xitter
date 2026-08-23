import { Tag } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

/**
 * antd's preset tag colours fail AA text contrast (green #389e0d on #f6ffed
 * is 3.37:1, orange #d46b08 on #fff7e6 ~3.6:1). Presets are not theme
 * tokens, so a11yTheme cannot fix them - dark text overrides ride along per
 * colour instead (the pattern health.tsx established before this component
 * existed). Red passes already (#cf1322 on #fff1f0 ≈ 5.5:1) but is
 * normalised here so every state tag reads the same way.
 */
const TEXT_OVERRIDES: Record<string, string> = {
  green: '#135200',
  orange: '#ad4e00',
  red: '#a8071a',
};

export function A11yTag({
  color,
  children,
  style,
}: {
  color: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const override = TEXT_OVERRIDES[color];
  return (
    <Tag color={color} style={{ color: override, ...style }}>
      {children}
    </Tag>
  );
}
