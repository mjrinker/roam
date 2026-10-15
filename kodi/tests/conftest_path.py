"""Puts the Kodi stand-ins and the add-on on the import path for every test file."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "stubs"))
sys.path.insert(0, os.path.join(HERE, "..", "plugin.video.roam"))
