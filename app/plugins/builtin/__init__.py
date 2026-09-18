"""
内置插件包
Built-in plugins package
"""

from app.plugins.builtin.restricted_bash import RestrictedBashPlugin
from app.plugins.builtin.code_viewer import CodeViewerPlugin
from app.plugins.builtin.git_committer import GitCommitterPlugin

__all__ = ["RestrictedBashPlugin", "CodeViewerPlugin", "GitCommitterPlugin"]
