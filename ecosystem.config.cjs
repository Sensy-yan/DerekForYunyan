module.exports = {
  apps: [
    {
      name: 'webapp',
      script: 'node',
      args: 'server.mjs',
      cwd: '/home/user/webapp',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        OPENAI_API_KEY: 'UgTF5g7Zs1X6AhqfONWWQ9phKX7RGGiW',
        OPENAI_BASE_URL: 'https://www.genspark.ai/api/llm_proxy/v1'
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
