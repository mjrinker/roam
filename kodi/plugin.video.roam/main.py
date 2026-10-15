"""Kodi entry point: every click on the add-on comes here with a plugin:// address."""
import sys

from resources.lib.router import run

if __name__ == "__main__":
    run(sys.argv)
