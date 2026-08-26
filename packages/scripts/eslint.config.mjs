import { nodeConfig } from '@xitter/eslint-config';

// Stryker sandboxes: a crashed mutate run leaves `.stryker-tmp/` behind
// (successful runs clean up), and the emitted JS there fails lint's project
// service. Ignored here because this workspace mutates (#90).
const ignoreStrykerTmp = { ignores: ['.stryker-tmp/**'] };

// CLI utilities: console output is the interface.
export default [
  ignoreStrykerTmp,
  ...nodeConfig.map((config) =>
    'rules' in config && config.rules && 'no-console' in config.rules
      ? { ...config, rules: { ...config.rules, 'no-console': 'off' } }
      : config,
  ),
];
