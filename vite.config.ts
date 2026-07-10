import { cloudflare } from "@cloudflare/vite-plugin";
import { think } from "@cloudflare/think/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const nonProjectFiles = [
  "**/*.md",
  "**/*.mdx",
  "docs/**",
  "references/**",
  "dist/**",
  "env.d.ts",
  "think.d.ts",
];

export default defineConfig({
  plugins: [think(), react(), cloudflare()],
  optimizeDeps: {
    entries: ["index.html"],
  },
  fmt: {
    ignorePatterns: nonProjectFiles,
    sortPackageJson: false,
  },
  lint: {
    ignorePatterns: nonProjectFiles,
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
