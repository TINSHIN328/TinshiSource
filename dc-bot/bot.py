import os
import asyncio
import aiohttp
import discord
from discord import app_commands

TOKEN = os.getenv("CONTROL_BOT_TOKEN", "").strip()
OWNER_ID = os.getenv("CONTROL_BOT_OWNER_ID", "1518966127546339439").strip() or "1518966127546339439"
API = os.getenv("CONTROL_BOT_API", "http://127.0.0.1:3000").rstrip("/")
SECRET = os.getenv("CONTROL_BOT_SECRET", "").strip()
LTC_ADDRESS = "ltc1qzqnep99a9p88lm0330n4hrcz38av2qs870sc2y"
COMMANDS_CHANNEL_ID = os.getenv("CONTROL_BOT_COMMANDS_CHANNEL_ID", "").strip()

if not TOKEN:
    raise SystemExit("CONTROL_BOT_TOKEN is not set")

int_owner = int(OWNER_ID) if OWNER_ID.isdigit() else 0

class TrailBot(discord.Client):
    def __init__(self):
        intents = discord.Intents.none()
        intents.guilds = True
        intents.messages = True
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)
        self.api_session: aiohttp.ClientSession | None = None
        self.commands_channel_id = COMMANDS_CHANNEL_ID

    async def setup_hook(self):
        self.api_session = aiohttp.ClientSession(headers={"X-Control-Secret": SECRET, "Content-Type": "application/json"})
        self.add_view(BuyView())
        try:
            status, data = await self.call("GET", "/api/internal/command-channel")
            if status < 400:
                self.commands_channel_id = str(data.get("channelId") or "").strip() or self.commands_channel_id
        except Exception as e:
            print(f"[CONTROL BOT] command channel load failed: {e}")
        await self.tree.sync()

    async def close(self):
        if self.api_session and not self.api_session.closed:
            await self.api_session.close()
        await super().close()

    async def call(self, method: str, path: str, **kwargs):
        assert self.api_session is not None
        async with self.api_session.request(method, API + path, **kwargs) as r:
            try:
                data = await r.json()
            except Exception:
                data = {"error": await r.text()}
            return r.status, data

bot = TrailBot()

@bot.event
async def on_message(message: discord.Message):
    """Keep the configured command channel owner-only.

    Non-owner messages in that channel are removed automatically.
    Bot-authored messages are ignored so embeds/buttons remain visible.
    """
    if message.author.bot:
        return
    if bot.commands_channel_id and str(message.channel.id) == bot.commands_channel_id:
        if not int_owner or message.author.id != int_owner:
            try:
                await message.delete()
            except (discord.Forbidden, discord.NotFound, discord.HTTPException) as e:
                print(f"[CONTROL BOT] could not delete message in command channel: {e}")

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
            self.add_item(BotActionButton(owner_id, bid, "start", f"▶ Start • {name}", discord.ButtonStyle.success, idx))
            self.add_item(BotActionButton(owner_id, bid, "stop", f"■ Stop • {name}", discord.ButtonStyle.danger, idx))
            self.add_item(DeleteBotButton(owner_id, bid, name, idx))
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

class DeleteBotConfirmView(discord.ui.View):
    def __init__(self, owner_id: int, bot_id: int):
        super().__init__(timeout=60)
        self.owner_id = owner_id
        self.bot_id = bot_id

    @discord.ui.button(label="Delete Bot", style=discord.ButtonStyle.danger, custom_id="tinshi:confirm_delete")
    async def confirm(self, interaction: discord.Interaction, _: discord.ui.Button):
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("Not your bot.", ephemeral=True); return
        await interaction.response.defer(ephemeral=True, thinking=True)
        status, data = await bot.call("DELETE", f"/api/internal/bot-delete/{self.bot_id}", json={"discord_id": str(self.owner_id)})
        if status >= 400:
            await interaction.followup.send(f"❌ {data.get('error','Delete failed.')}", ephemeral=True); return
        await send_manager(interaction, self.owner_id, data.get("message", "Bot deleted successfully."))

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary, custom_id="tinshi:cancel_delete")
    async def cancel(self, interaction: discord.Interaction, _: discord.ui.Button):
        await interaction.response.edit_message(content="Delete cancelled.", view=None)

class DeleteBotButton(discord.ui.Button):
    def __init__(self, owner_id: int, bot_id: int, name: str, row: int):
        super().__init__(label=f"✕ Delete • {name}"[:80], style=discord.ButtonStyle.danger, custom_id=f"tinshi:delete:{bot_id}", row=min(row,4))
        self.owner_id, self.bot_id = owner_id, bot_id

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.owner_id:
            await interaction.response.send_message("This bot manager belongs to another user.", ephemeral=True); return
        await interaction.response.send_message(
            f"⚠️ **Delete bot #{self.bot_id}?**\nThis stops the process and permanently removes its database record and runtime/config files.",
            view=DeleteBotConfirmView(self.owner_id, self.bot_id), ephemeral=True
        )

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
    embed = discord.Embed(title="TinshiSource • Bot Manager", description="Manage your bots, plans and payments here.")
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
    await interaction.followup.send("✅ **24-hour trial activated.**\nUse **/add_bot** or **/manage_bots** to configure your bot. ",ephemeral=True)


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

class CustomEmbedModal(discord.ui.Modal, title="TinshiSource • Custom Embed"):
    channel_id = discord.ui.TextInput(label="Channel ID", placeholder="123456789012345678", min_length=15, max_length=22)
    title = discord.ui.TextInput(label="Embed Title", placeholder="Your title", min_length=1, max_length=256)
    description = discord.ui.TextInput(label="Embed Description", placeholder="Your message...", style=discord.TextStyle.paragraph, min_length=1, max_length=4000)
    footer = discord.ui.TextInput(label="Footer (optional)", placeholder="TinshiSource", required=False, max_length=2048)

    async def on_submit(self, interaction: discord.Interaction):
        if not int_owner or interaction.user.id != int_owner:
            await interaction.response.send_message("Owner only.", ephemeral=True); return
        cid = str(self.channel_id.value).strip()
        if not cid.isdigit() or not 15 <= len(cid) <= 22:
            await interaction.response.send_message("Invalid Discord channel ID.", ephemeral=True); return
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            channel = await bot.fetch_channel(int(cid))
            if not hasattr(channel, "send"):
                raise RuntimeError("That channel cannot receive messages.")
            embed = discord.Embed(title=str(self.title.value).strip(), description=str(self.description.value).strip())
            footer = str(self.footer.value).strip()
            if footer:
                embed.set_footer(text=footer)
            await channel.send(embed=embed)
            await interaction.followup.send(f"✅ Custom embed sent to <#{cid}>.", ephemeral=True)
        except Exception as e:
            await interaction.followup.send(f"❌ Could not send embed: {e}", ephemeral=True)

@bot.tree.command(name="send_emb", description="Owner-only: send a default or custom embed")
@app_commands.describe(mode="Choose the embed type", channel_id="Target Discord channel ID (required for Default)")
@app_commands.choices(mode=[
    app_commands.Choice(name="Default", value="default"),
    app_commands.Choice(name="Custom", value="custom"),
])
async def send_emb(interaction: discord.Interaction, mode: app_commands.Choice[str], channel_id: str | None = None):
    if not int_owner or interaction.user.id != int_owner:
        await interaction.response.send_message("Owner only.", ephemeral=True); return
    if mode.value == "custom":
        await interaction.response.send_modal(CustomEmbedModal())
        return
    cid = str(channel_id or "").strip()
    if not cid.isdigit() or not 15 <= len(cid) <= 22:
        await interaction.response.send_message("For **Default**, provide a valid channel ID in `channel_id`.", ephemeral=True); return
    await interaction.response.defer(ephemeral=True, thinking=True)
    try:
        channel = await bot.fetch_channel(int(cid))
        if not hasattr(channel, "send"):
            raise RuntimeError("That channel cannot receive messages.")
        ltc = LTC_ADDRESS or "LTC_ADDRESS is not configured"
        embed = discord.Embed(title="TinshiSource • Premium Plans", description="Choose a plan and submit your Litecoin payment.")
        embed.add_field(name="Monthly Premium", value="$8 / 30 days • 1 bot slot • 24/7 controls", inline=False)
        embed.add_field(name="Extra Bot Slot", value="$4 per additional slot", inline=False)
        embed.add_field(name="Litecoin", value=f"`{ltc}`", inline=False)
        embed.set_footer(text="TinshiSource")
        await channel.send(embed=embed, view=BuyView())
        await interaction.followup.send(f"✅ Default embed sent to <#{cid}>.", ephemeral=True)
    except Exception as e:
        await interaction.followup.send(f"❌ Could not send embed: {e}", ephemeral=True)

class ImportantMessageModal(discord.ui.Modal, title="TinshiSource • Important Message"):
    message = discord.ui.TextInput(label="Message", placeholder="Important announcement...", style=discord.TextStyle.paragraph, min_length=1, max_length=4000)

    async def on_submit(self, interaction: discord.Interaction):
        if not int_owner or interaction.user.id != int_owner:
            await interaction.response.send_message("Owner only.", ephemeral=True); return
        cid = str(bot.commands_channel_id or "").strip()
        if not cid:
            await interaction.response.send_message("Set the commands channel first with **/set_channel**.", ephemeral=True); return
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            channel = await bot.fetch_channel(int(cid))
            await channel.send(embed=discord.Embed(title="Important Message", description=str(self.message.value).strip()))
            await interaction.followup.send(f"✅ Important message sent to <#{cid}>.", ephemeral=True)
        except Exception as e:
            await interaction.followup.send(f"❌ Could not send message: {e}", ephemeral=True)

@bot.tree.command(name="set_channel", description="Owner-only: set the channel where only commands and owner messages are allowed")
@app_commands.describe(channel_id="Discord channel ID")
async def set_channel(interaction: discord.Interaction, channel_id: str):
    if not int_owner or interaction.user.id != int_owner:
        await interaction.response.send_message("Owner only.", ephemeral=True); return
    cid = str(channel_id).strip()
    if not cid.isdigit() or not 15 <= len(cid) <= 22:
        await interaction.response.send_message("Invalid Discord channel ID.", ephemeral=True); return
    await interaction.response.defer(ephemeral=True, thinking=True)
    try:
        channel = await bot.fetch_channel(int(cid))
        if not hasattr(channel, "send"):
            raise RuntimeError("That channel cannot receive messages.")
        status, data = await bot.call("POST", "/api/internal/command-channel", json={"discord_id": str(interaction.user.id), "channel_id": cid})
        if status >= 400:
            await interaction.followup.send(f"❌ {data.get('error','Could not save channel.')}", ephemeral=True); return
        bot.commands_channel_id = cid
        await interaction.followup.send(f"✅ Commands channel set to <#{cid}>. Normal chat from other users will be deleted automatically.", ephemeral=True)
    except Exception as e:
        await interaction.followup.send(f"❌ Could not set channel: {e}", ephemeral=True)

@bot.tree.command(name="important_msg", description="Owner-only: send an important message to the commands channel")
async def important_msg(interaction: discord.Interaction):
    if not int_owner or interaction.user.id != int_owner:
        await interaction.response.send_message("Owner only.", ephemeral=True); return
    await interaction.response.send_modal(ImportantMessageModal())

@bot.tree.command(name="web_login", description="Get/reset your website username and password")
async def web_login(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True, thinking=True)
    status, data = await bot.call("POST", "/api/internal/web-credentials", json={"discord_id": str(interaction.user.id)})
    if status >= 400:
        await interaction.followup.send(f"❌ {data.get('error','Unable to create web credentials.')}", ephemeral=True); return
    await interaction.followup.send(
        "🔐 **Website Login**\n"
        f"Username: `{data.get('username')}`\n"
        f"Password: `{data.get('password')}`\n"
        f"Website: {data.get('websiteUrl') or data.get('webUrl') or 'Website URL is not configured.'}\n\n"
        "Keep these credentials private. Running `/web_login` again resets the password.",
        ephemeral=True
    )

@bot.tree.command(name="control_status", description="Show control bot status (owner only)")
async def control_status(interaction: discord.Interaction):
    if not int_owner or interaction.user.id != int_owner: await interaction.response.send_message("Owner only.",ephemeral=True); return
    await interaction.response.send_message(f"✅ Control bot online as **{bot.user}**",ephemeral=True)

async def main():
    async with bot:
        await bot.start(TOKEN)

asyncio.run(main())
