
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
    plugins: [
        wasm(),
        topLevelAwait(),
        nodePolyfills({
            globals: {
                Buffer: true,
                global: true,
                process: true,
            },
        }),
    ],
    server: {
        port: 3000,
        host: true,
    },
    optimizeDeps: {
        include: ['buffer', 'process']
    }
});

