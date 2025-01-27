
module.exports = {
  apps: [{
    name: "whatbot",
    script: "index.js",
    watch: ["index.js"],
    max_memory_restart: "1G",
    env: {
      NODE_ENV: "production",
      PM2_USAGE: "true"
    },
    autorestart: true,
    restart_delay: 4000,
    log_date_format: "YYYY-MM-DD HH:mm:ss Z"
  }]
};