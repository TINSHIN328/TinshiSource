import os
import asyncio
import aiohttp
import discord
from discord import app_commands

TOKEN = os.getenv("CONTROL_BOT_TOKEN", "").strip()
OWNER_ID = os.getenv("CONTROL_BOT_OWNER_ID", "1518966127546339439").strip() or "1518966127546339439"
API = os.getenv("CONTROL_BOT_API", "http://127.0.0.1:3000").rstrip("/")
SECRET = os.getenv("CONTROL_BOT_SECRET", "").strip()
LTC_ADDRESS = os.getenv("LTC_ADDRESS", "").strip()

if not TOKEN:
    raise SystemExit("CONTROL_BOT_TOKEN is not set")

int_owner = int(OWNER_ID) if OWNER_ID.isdigit() else 0

class TrailBot(discord.Client):
    def __init__(self):
        intents = discord.Intents.none()
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)
        self.http: aiohttp.ClientSession | None = None

    async def setup_hook(self):
        self.http = aiohttp.ClientSession(headers={"X-Control-Secret": SECRET, "Content-Type": "application/json"})
        self.add_view(BuyView())
        await self.tree.sync()

    async def close(self):
        if self.http and not self.http.closed:
            await self.http.close()
        await super().close()

    async def call(self, method: str, path: str, **kwargs):
        assert self.http is not None
        async with self.http.request(method, API + path, **kwargs) as r:
            try:
                data = await r.json()
            except Exception:
                data = {"error": await r.text()}
            return r.status, data

bot = TrailBot()

@bot.event
async def on_ready():
    print(f"[CONTROL BOT] logged in as {bot.user} ({bot.user.id})")
    if int_owner:
        print(f"[CONTROL BOT] owner control id configured: {int_owner}")

async def get_bots(discord_id: int):
    status, data = await bot.call("GET", "/api/internal/bots", params={"discord_id": str(discord_id)})
    if status >= 400:
        raise RuntimeError(data.get("error", "Unable to load bots."))
    return data

class BotControlView(discord.ui.View):
    def __init__(self, owner_id: int, bot_rows: list[dict]):
        super().__init__(timeout=300)
        self.owner_id = owner_id
        for idx, row in enumerate(bot_rows[:5]):
            bid = int(row["id"])
            name = str(row.get("bot_name", f"Bot {bid}"))[:70]
            self.add_item(BotActionButton(owner_id, bid, "start", f"▶ {name}", discord.ButtonStyle.success, idx))
            self.add_item(BotActionButton(owner_id, bid, "stop", f"■ {name}", discord.ButtonStyle.danger, idx))
        if bot_rows:
            self.add_item(RefreshBotsButton(owner_id))
        self.add_item(CreateBotButton())

class BotActionButton(discord.ui.Button):
    def __init__(self, owner_id: int, bot_id: int, action: str, label: str, style: discord.ButtonStyle, row: int):
        super().__init__(label=label, style=style, custom_id=f"tinshi:{action}:{bot_id}", row=row)
        self.owner_id, self.bot_id, self.action = owner_id, bot_id, action
    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("This bot manager belongs to another user.", ephemeral=True); return
        await interaction.response.defer(ephemeral=True, thinking=True)
        path = "/api/internal/bot-start" if self.action == "start" else "/api/internal/bot-stop"
        status, data = await bot.call("POST", path, json={"discord_id": str(self.owner_id), "bot_id": self.bot_id})
        if status >= 400:
            await interaction.followup.send(f"❌ {data.get('error','Action failed.')}", ephemeral=True); return
        await send_manager(interaction, self.owner_id, "Bot action completed.")

class RefreshBotsButton(discord.ui.Button):
    def __init__(self, owner_id: int):
        super().__init__(label="↻ Refresh", style=discord.ButtonStyle.secondary, custom_id=f"tinshi:refresh:{owner_id}")
        self.owner_id=owner_id
    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("Not your manager.", ephemeral=True); return
        await interaction.response.defer(ephemeral=True, thinking=True)
        await send_manager(interaction, self.owner_id)

class CreateBotButton(discord.ui.Button):
    def __init__(self):
        super().__init__(label="＋ Add Bot", style=discord.ButtonStyle.primary, custom_id="tinshi:create")
    async def callback(self, interaction: discord.Interaction):
        await interaction.response.send_modal(BotModal())

async def send_manager(interaction: discord.Interaction, discord_id: int, notice: str | None = None):
    try:
        data = await get_bots(discord_id)
    except Exception as e:
        await interaction.followup.send(f"❌ {e}", ephemeral=True); return
    rows = data.get("bots", [])
    u_until = data.get("premiumUntil")
    embed = discord.Embed(title="TinshiSource • Bot Manager", description="Everything is managed here in Discord. No web redirect is required.")
    embed.add_field(name="Access", value=(f"Active until: <t:{int(__import__('datetime').datetime.fromisoformat(u_until.replace('Z','+00:00')).timestamp())}:F>" if u_until else "No active trial/subscription"), inline=False)
    if rows:
        for r in rows[:10]:
            st = r.get("status", "stopped")
            embed.add_field(name=f"#{r['id']} • {r.get('bot_name','Bot')}", value=f"Status: **{st}**\nOwner: `{r.get('owner_id','—')}`\nChannel: `{r.get('channel_id','—')}`", inline=True)
    else:
        embed.add_field(name="Bots", value="No bots yet. Click **＋ Add Bot**.", inline=False)
    if notice: embed.set_footer(text=notice)
    await interaction.followup.send(embed=embed, view=BotControlView(discord_id, rows) if rows else BotControlView(discord_id, []), ephemeral=True)

class BotModal(discord.ui.Modal, title="TinshiSource • Add Bot"):
    bot_name = discord.ui.TextInput(label="Bot Name", placeholder="My Discord Bot", min_length=1, max_length=100)
    bot_token = discord.ui.TextInput(label="Bot Token", placeholder="Paste the Discord bot token", min_length=20, max_length=200, style=discord.TextStyle.short)
    owner_id = discord.ui.TextInput(label="Owner ID", placeholder="Discord user ID", min_length=15, max_length=22, style=discord.TextStyle.short)
    channel_id = discord.ui.TextInput(label="Channel ID", placeholder="Discord channel ID", min_length=15, max_length=22, style=discord.TextStyle.short)
    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        owner_id = str(self.owner_id.value).strip() or str(interaction.user.id)
        payload = {"discord_id": str(interaction.user.id), "bot_name": str(self.bot_name.value).strip(), "bot_token": str(self.bot_token.value).strip(), "owner_id": owner_id, "channel_id": str(self.channel_id.value).strip()}
        status, data = await bot.call("POST", "/api/internal/manage-bots", json=payload)
        if status >= 400:
            await interaction.followup.send(f"❌ {data.get('error', 'Unable to create the bot.')}", ephemeral=True); return
        await send_manager(interaction, interaction.user.id, f"{data.get('botName','Bot')} was written to its template config and started.")

class BuyModal(discord.ui.Modal, title="TinshiSource • Submit Payment"):
    amount = discord.ui.TextInput(label="Amount (8 or 4 USD)", placeholder="8", min_length=1, max_length=2)
    txid = discord.ui.TextInput(label="Litecoin Transaction ID", placeholder="Paste TXID", min_length=20, max_length=128)
    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        try: amount=int(str(self.amount.value).strip())
        except ValueError: await interaction.followup.send("Amount must be 8 or 4.", ephemeral=True); return
        status,data=await bot.call("POST","/api/internal/payment-submit",json={"discord_id":str(interaction.user.id),"amount":amount,"txid":str(self.txid.value).strip()})
        await interaction.followup.send(("✅ "+data.get("message","Payment submitted.")) if status<400 else "❌ "+data.get("error","Payment submission failed."),ephemeral=True)

class BuyView(discord.ui.View):
    def __init__(self): super().__init__(timeout=None)
    @discord.ui.button(label="Submit Payment",style=discord.ButtonStyle.primary,custom_id="tinshi:buy")
    async def buy(self,interaction:discord.Interaction,_:discord.ui.Button): await interaction.response.send_modal(BuyModal())

@bot.tree.command(name="plans", description="View TinshiSource plans and payment options")
async def plans(interaction: discord.Interaction):
    ltc=LTC_ADDRESS or "LTC_ADDRESS is not configured"
    embed=discord.Embed(title="TinshiSource Plans",description="Premium access and bot slots are managed entirely in Discord.")
    embed.add_field(name="Premium",value="$8 / 30 days • 1 bot slot • 24/7 bot controls",inline=False)
    embed.add_field(name="Extra Slot",value="$4 per additional bot slot",inline=False)
    embed.add_field(name="Litecoin",value=f"`{ltc}`",inline=False)
    await interaction.response.send_message(embed=embed,view=BuyView(),ephemeral=True)

@bot.tree.command(name="buy", description="Submit a TinshiSource Litecoin payment")
async def buy(interaction: discord.Interaction): await interaction.response.send_modal(BuyModal())

@bot.tree.command(name="add_bot", description="Add a Discord bot using token, owner ID and channel ID")
async def add_bot(interaction: discord.Interaction): await interaction.response.send_modal(BotModal())

async def activate_trial(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True,thinking=True)
    status,data=await bot.call("POST","/api/internal/trial",json={"discord_id":str(interaction.user.id)})
    if status>=400: await interaction.followup.send("❌ "+data.get("error","Unable to activate trial."),ephemeral=True); return
    await interaction.followup.send("✅ **24-hour trial activated.**\nUse **/add_bot** or **/manage_bots** to configure your bot. Everything stays inside Discord.",ephemeral=True)

@bot.tree.command(name="trail", description="Activate a 24-hour TinshiSource bot trial")
async def trail(interaction: discord.Interaction):
    await activate_trial(interaction)

@bot.tree.command(name="trial", description="Alias for the 24-hour TinshiSource trial")
async def trial(interaction: discord.Interaction): await activate_trial(interaction)

@bot.tree.command(name="manage_bots", description="Open your complete private bot manager")
async def manage_bots(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True,thinking=True)
    await send_manager(interaction, interaction.user.id)

@bot.tree.command(name="bot_status", description="Show your bot status and runtime stats")
async def bot_status(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True,thinking=True)
    data=await get_bots(interaction.user.id)
    rows=data.get("bots",[])
    if not rows: await interaction.followup.send("No bots configured. Use **/add_bot**.",ephemeral=True); return
    embed=discord.Embed(title="TinshiSource • Live Bot Stats")
    for r in rows[:10]:
        st,extra=r.get("status","stopped"),""
        try:
            _,d=await bot.call("GET","/api/internal/bot-status",params={"discord_id":str(interaction.user.id),"bot_id":str(r["id"])})
            st=d.get("state",st); extra=f"\nPID: `{d.get('pid') or '—'}`\nUptime: `{int((d.get('uptime') or 0)/1000)}s`"
        except: pass
        embed.add_field(name=f"#{r['id']} • {r.get('bot_name','Bot')}",value=f"Status: **{st}**{extra}",inline=False)
    await interaction.followup.send(embed=embed,ephemeral=True)

@bot.tree.command(name="admin", description="Owner-only Discord admin controls")
async def admin(interaction: discord.Interaction):
    if not int_owner or interaction.user.id != int_owner:
        await interaction.response.send_message("Owner only.", ephemeral=True); return
    await interaction.response.defer(ephemeral=True, thinking=True)
    status,data=await bot.call("GET","/api/internal/payments")
    if status>=400: await interaction.followup.send("❌ "+data.get("error","Unable to load payments."),ephemeral=True); return
    rows=data.get("pending",[])
    embed=discord.Embed(title="TinshiSource • Admin",description="Pending payments can be approved or rejected directly in Discord.")
    if not rows: embed.add_field(name="Pending",value="No pending payments.",inline=False)
    for r in rows[:10]: embed.add_field(name=r["username"],value=f"${r['amountUsd']} • `{r['txid']}`",inline=False)
    await interaction.followup.send(embed=embed,view=PaymentAdminView(rows) if rows else None,ephemeral=True)

class PaymentAdminView(discord.ui.View):
    def __init__(self, rows):
        super().__init__(timeout=300)
        for r in rows[:5]:
            self.add_item(PaymentButton(r["username"],True))
            self.add_item(PaymentButton(r["username"],False))

class PaymentButton(discord.ui.Button):
    def __init__(self,username,approve):
        super().__init__(label=("Approve " if approve else "Reject ")+username[:45],style=discord.ButtonStyle.success if approve else discord.ButtonStyle.danger,custom_id=f"tinshi:pay:{'a' if approve else 'r'}:{username}")
        self.username=username; self.approve=approve
    async def callback(self,interaction):
        if not int_owner or interaction.user.id!=int_owner: await interaction.response.send_message("Owner only.",ephemeral=True); return
        await interaction.response.defer(ephemeral=True,thinking=True)
        path="/api/internal/payment-approve" if self.approve else "/api/internal/payment-reject"
        status,data=await bot.call("POST",path,json={"username":self.username})
        await interaction.followup.send(("✅ Payment approved." if self.approve else "🗑️ Payment rejected.") if status<400 else "❌ "+data.get("error","Action failed."),ephemeral=True)

@bot.tree.command(name="control_status", description="Show control bot status (owner only)")
async def control_status(interaction: discord.Interaction):
    if not int_owner or interaction.user.id != int_owner: await interaction.response.send_message("Owner only.",ephemeral=True); return
    await interaction.response.send_message(f"✅ Control bot online as **{bot.user}**",ephemeral=True)

async def main():
    async with bot:
        await bot.start(TOKEN)

asyncio.run(main())
