"""服务器入口：支持 `python -m server.main` 启动。"""
import uvicorn
import logging

from . import config

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s: %(message)s')

if __name__ == '__main__':
    uvicorn.run(
        'server.main:app',
        host=config.HOST,
        port=config.PORT,
        log_level='info',
        proxy_headers=config.TRUST_PROXY,
        forwarded_allow_ips='*' if config.TRUST_PROXY else '',
    )
