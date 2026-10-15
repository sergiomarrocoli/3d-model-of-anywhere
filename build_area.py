#!/usr/bin/env python3
"""Build a game tile bundle for one box. Thin wrapper over `pipeline.build_area`.

    python3 build_area.py --bbox 375000 164500 375500 165000 --id bath
    python3 build_area.py --bbox 258500 347700 259000 348200 --id beddgelert
    python3 build_area.py --centre 375250 164750 --id bath            # 500 m box around a point
"""
from pipeline.build_area import main

if __name__ == "__main__":
    main()
