const postcssPresetMantine = require("postcss-preset-mantine");
const postcssSimpleVars = require("postcss-simple-vars");

module.exports = {
  plugins: [
    postcssPresetMantine.default ?? postcssPresetMantine,
    postcssSimpleVars.default ?? postcssSimpleVars,
  ],
};
