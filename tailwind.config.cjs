module.exports = {
  content: ["./frontend/index.html", "./frontend/src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "PingFang SC",
          "Microsoft YaHei",
          "sans-serif"
        ]
      },
      colors: {
        clay: {
          50: "#f5f6f4",
          100: "#ecefed",
          200: "#dfe4e1",
          300: "#c7d0cb",
          600: "#66736d",
          800: "#353c39",
          900: "#202724"
        },
        moss: "#6f8f7a",
        ember: "#bc7a45",
        iris: "#8477b7"
      },
      boxShadow: {
        neu: "14px 14px 30px rgba(145, 154, 149, 0.42), -9px -9px 22px rgba(246, 249, 247, 0.62)",
        "neu-sm": "8px 8px 18px rgba(145, 154, 149, 0.36), -6px -6px 15px rgba(246, 249, 247, 0.62)",
        insetNeu: "inset 8px 8px 18px rgba(145, 154, 149, 0.32), inset -8px -8px 18px rgba(246, 249, 247, 0.62)"
      }
    }
  },
  plugins: []
};
