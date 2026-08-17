module.exports = {
  apps: [{
    name: "marine-bot",
    script: "dist/interfaces/runtime/production.js",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    restart_delay: 5000,
    max_memory_restart: "700M",
    env: { NODE_ENV: "production" },
  }],
};
