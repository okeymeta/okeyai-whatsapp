module.exports = {
  apps: [{
    name: "whatbot",
    script: "index.js",
    type: "module",
    watch: false,
    max_memory_restart: "1G",
    env: {
      NODE_ENV: "production",
      PM2_USAGE: "true"
    },
    // Restart on file changes
    watch: ["index.js"],
    // Restart if memory usage exceeds 1GB
    max_memory_restart: "1G",
    // Restart on crash
    autorestart: true,
    // Restart delay
    restart_delay: 4000,
    // Keep logs
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
  }]
};
