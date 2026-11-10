@echo off
wsl -d Ubuntu -e bash -lc "cd ~/Agent-Squad && scripts/start-agents.sh && tmux attach -t agents"
