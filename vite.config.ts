import { cloudflare } from "@cloudflare/vite-plugin";
import { think } from "@cloudflare/think/vite";
import react from "@vitejs/plugin-react";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite-plus";

const nonProjectFiles = [
  "**/*.md",
  "**/*.mdx",
  "docs/**",
  "references/**",
  "dist/**",
  "env.d.ts",
  "think.d.ts",
];

function removeLocalSecretsFromBuild(): Plugin {
  let outputDirectory = "dist";

  return {
    name: "remove-local-secrets-from-build",
    configResolved(config) {
      outputDirectory = config.build.outDir;
    },
    async closeBundle() {
      await rm(resolve(outputDirectory, ".dev.vars"), { force: true });
    },
  };
}

export default defineConfig({
  plugins: [think(), react(), cloudflare(), removeLocalSecretsFromBuild()],
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
