#!/bin/bash

# Polymarket Trading Bot Setup Script

echo "🦞 Polymarket Trading Bot Setup"
echo "================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js >=18 first."
    exit 1
fi

echo "✅ Node.js version: $(node --version)"
echo ""

# Create environment file
ENV_FILE="$HOME/.polymarket-trader.env"

echo "📝 Setting up credentials..."
echo ""
echo "Please enter your Polymarket API credentials:"
echo ""

read -p "API Key: " api_key
read -p "Secret: " secret
read -p "Passphrase: " passphrase
read -p "Address: " address

# Create environment file
cat > "$ENV_FILE" << EOF
# Polymarket API Credentials
export POLYMARKET_API_KEY="$api_key"
export POLYMARKET_SECRET="$secret"
export POLYMARKET_PASSPHRASE="$passphrase"
export POLYMARKET_ADDRESS="$address"

# Risk Management Parameters
export MAX_POSITION_SIZE=0.20
export MIN_POSITION_SIZE=5
export MAX_LOSS=0.30
export TAKE_PROFIT_TARGET=2.5

# Trading Parameters
export CONFIDENCE_THRESHOLD=0.65
export MAX_CONCURRENT_POSITIONS=3
EOF

chmod 600 "$ENV_FILE"

echo ""
echo "✅ Credentials saved to: $ENV_FILE"
echo ""
echo "To load credentials in your shell, run:"
echo "  source $ENV_FILE"
echo ""
echo "To make this permanent, add to your ~/.zshrc or ~/.bashrc:"
echo "  echo 'source $ENV_FILE' >> ~/.zshrc"
echo ""

# Make trader script executable
TRADER_SCRIPT="$(dirname "$0")/trader.js"
chmod +x "$TRADER_SCRIPT"

echo "✅ Trader script is now executable"
echo ""
echo "🎯 Setup Complete!"
echo ""
echo "Next steps:"
echo "1. Load credentials: source $ENV_FILE"
echo "2. Test connection: node $TRADER_SCRIPT"
echo "3. Use in Clawdbot: /polymarket-trader analyze"
echo ""
