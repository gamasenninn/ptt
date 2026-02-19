"""
AI音声アシスタント起動スクリプト

環境変数 USE_AGENT_SDK で実装を切り替え:
  - true (デフォルト): Agent SDK版 (ai_assistant_agent.py)
  - false: FastMCP版 (ai_assistant.py)

Usage:
  uv run python run_assistant.py
"""
import os
from dotenv import load_dotenv

load_dotenv()

USE_AGENT_SDK = os.environ.get("USE_AGENT_SDK", "true").lower() == "true"

if __name__ == "__main__":
    if USE_AGENT_SDK:
        print("[run_assistant] Agent SDK版を起動")
        from ai_assistant_agent import main
    else:
        print("[run_assistant] FastMCP版を起動")
        from ai_assistant import main

    main()
