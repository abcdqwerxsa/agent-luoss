"""
统一日志记录模块
Structured Logger Configuration
"""

import logging
import sys


def setup_logger(name: str = "agent-luoss", level: int = logging.INFO) -> logging.Logger:
    """
    配置并返回统一格式的结构化日志器
    """
    logger = logging.getLogger(name)
    if not logger.handlers:
        logger.setLevel(level)
        handler = logging.StreamHandler(sys.stdout)
        handler.setLevel(level)
        formatter = logging.Formatter(
            fmt="[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)
        logger.propagate = False
    return logger


logger = setup_logger()
