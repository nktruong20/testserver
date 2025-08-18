// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const https = require('https');
const axios = require('axios');
const vnstock = require('vnstock-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// =============================

// 1) KẾT NỐI MONGODB
// =============================
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.DB_URL);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
};

// =============================
// 2) MONGOOSE MODELS
// =============================
const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Tên không được bỏ trống']
  },
  email: {
    type: String,
    required: [true, 'Email không được bỏ trống'],
    unique: true
  },
  password: {
    type: String,
    required: [true, 'Mật khẩu không được bỏ trống']
  }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

const watchlistSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  symbol: {
    type: String,
    required: [true, 'Mã cổ phiếu không được bỏ trống'],
    uppercase: true,
    trim: true
  },
  buyPrice: {
    type: Number,
    required: [true, 'Giá mua không được bỏ trống']
  },
  note: {
    type: String
  }
}, { timestamps: true });

const Watchlist = mongoose.model('Watchlist', watchlistSchema);

// =============================
// 3) MIDDLEWARE AUTH (JWT)
// =============================
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ success: false, message: 'Không có token' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // gán user vào req
    next();
  } catch (err) {
    res.status(403).json({ success: false, message: 'Token không hợp lệ' });
  }
};

// =============================
// 4) CONTROLLERS: AUTH
// =============================
const authController = {
  // Đăng ký
  register: async (req, res) => {
    try {
      const { name, email, password } = req.body;

      if (!name || !email || !password) {
        return res.status(400).json({ success: false, message: 'Tên, email và mật khẩu là bắt buộc' });
      }

      const exist = await User.findOne({ email });
      if (exist) {
        return res.status(400).json({ success: false, message: 'Email đã tồn tại' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = await User.create({
        name,
        email,
        password: hashedPassword
      });

      res.json({
        success: true,
        message: 'Đăng ký thành công',
        user: { id: newUser._id, name: newUser.name, email: newUser.email }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  // Đăng nhập
  login: async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email và mật khẩu là bắt buộc' });
      }

      const user = await User.findOne({ email });
      if (!user) {
        return res.status(400).json({ success: false, message: 'Email không tồn tại' });
      }

      const match = await bcrypt.compare(password, user.password);
      if (!match) {
        return res.status(400).json({ success: false, message: 'Mật khẩu không đúng' });
      }

      // Nhúng name vào token
      const token = jwt.sign(
        { id: user._id, email: user.email, name: user.name },
        process.env.JWT_SECRET,
        { expiresIn: '1d' }
      );

      res.json({
        success: true,
        message: 'Đăng nhập thành công',
        token,
        user: { id: user._id, name: user.name, email: user.email }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

// =============================
// 5) CONTROLLERS: STOCKS
// =============================
const stocksController = {
  // Lấy dữ liệu giao dịch theo mã (real-time trades)
  getStockTrades: (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const url = `https://bgapidatafeed.vps.com.vn/getliststocktrade/${symbol}`;

    https.get(url, { family: 4 }, (resp) => {
      let data = '';

      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);

          if (!Array.isArray(json) || json.length === 0) {
            return res.status(404).json({ success: false, message: 'Không có dữ liệu giao dịch' });
          }

          res.json({
            success: true,
            symbol,
            trades: json.map(trade => ({
              time: trade.time,
              lastPrice: trade.lastPrice,
              lastVol: trade.lastVol,
              totalVol: trade.totalVol
            }))
          });
        } catch (e) {
          res.status(500).json({ success: false, error: 'Không parse được JSON', raw: data });
        }
      });
    }).on('error', (err) => {
      res.status(500).json({ success: false, error: err.message });
    });
  },

  // Lấy dữ liệu cơ bản của nhiều mã
  getStocksData: async (req, res) => {
    try {
      const codes = req.query.codes;
      if (!codes) {
        return res.status(400).json({ success: false, message: 'Vui lòng nhập mã chứng khoán, ví dụ ?codes=FPT,ACB' });
      }

      const codeList = codes.split(',').map(code => code.trim().toUpperCase());
      let results = [];

      for (const code of codeList) {
        const url = `https://bgapidatafeed.vps.com.vn/getliststockdata/${code}`;
        const response = await axios.get(url);
        if (response.data && response.data.length > 0) {
          results.push(response.data[0]);
        }
      }

      res.json({
        success: true,
        total: results.length,
        data: results
      });

    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  // Lịch sử giá / quote
  getStockHistory: async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    try {
      const result = await vnstock.stock.quote({ ticker: symbol, start: '2025-01-01' });
      res.json({ success: true, symbol, quote: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  // Top gainers
  getTopGainers: async (_req, res) => {
    try {
      const data = await vnstock.stock.topGainers();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  // Top losers
  getTopLosers: async (_req, res) => {
    try {
      const data = await vnstock.stock.topLosers();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  // Tìm kiếm thông tin cổ phiếu theo mã
  searchStock: async (req, res) => {
    try {
      const symbol = (req.query.symbol || '').toUpperCase();
      if (!symbol) {
        return res.status(400).json({ success: false, message: 'Vui lòng nhập mã chứng khoán' });
      }

      const url = `https://bgapidatafeed.vps.com.vn/getliststockdata/${symbol}`;
      const response = await axios.get(url);

      if (!response.data || response.data.length === 0) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy dữ liệu cho mã cổ phiếu này' });
      }

      // Lấy lịch sử giá để có giá đóng cửa hôm qua
      const history = await vnstock.stock.quote({ ticker: symbol, start: '2025-01-01', limit: 2 });
      const yesterdayPrice = history[1]?.close || response.data[0].lastPrice;

      res.json({
        success: true,
        data: {
          symbol,
          currentPrice: response.data[0].lastPrice,
          yesterdayPrice,
          ...response.data[0]
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
};

// =============================
// 6) APP + SERVER + SOCKET.IO
// =============================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Kết nối DB
connectDB();

// Middlewares
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// =============================
// 7) WATCHLIST: price fetch + updater (dùng io bên trên)
// =============================

// Hàm lấy giá cổ phiếu từ VNDirect (từ trang đầu tiên)
function fetchPrice(symbol) {
  return new Promise((resolve, reject) => {
    const url = `https://api-finfo.vndirect.com.vn/v4/effective_secinfo?q=code:${symbol}`;

    const options = {
      family: 4,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36',
        'Accept': 'application/json'
      }
    };

    https.get(url, options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          if (data.startsWith('Access Denied')) {
            return reject(new Error('VNDirect chặn truy cập: ' + data));
          }
          const json = JSON.parse(data);
          if (!json.data || json.data.length === 0) return resolve(null);
          const stock = json.data[0];
          resolve({
            symbol: stock.code,
            basicPrice: stock.basicPrice, // Giá tham chiếu
            ceilPrice: stock.ceilPrice,   // Giá trần
            floorPrice: stock.floorPrice, // Giá sàn
            matchPrice: stock.matchPrice, // Giá khớp lệnh
            tradingDate: stock.tradingDate
          });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Hàm cập nhật watchlist và phát dữ liệu qua Socket.IO
async function updateWatchlist() {
  try {
    const users = await Watchlist.distinct('userId');

    for (const userId of users) {
      const items = await Watchlist.find({ userId });
      const enrichedItems = [];

      for (const item of items) {
        try {
          const data = await fetchPrice(item.symbol);

          if (data) {
            // Chuẩn hóa giá: tối đa 2 số thập phân
            const yesterdayPrice = Number((data.basicPrice || 0).toFixed(2));
            const currentPrice = Number((data.matchPrice || 0).toFixed(2));
            const buyPrice = Number((item.buyPrice || 0).toFixed(2));

            const buyPriceYesterdayDiff = yesterdayPrice !== 0
              ? (((currentPrice - yesterdayPrice) / yesterdayPrice) * 100).toFixed(2)
              : 0;
            const buyPriceDiff = buyPrice !== 0
              ? (((currentPrice - buyPrice) / buyPrice) * 100).toFixed(2)
              : 0;

            enrichedItems.push({
              _id: item._id,
              symbol: item.symbol,
              buyPrice,
              yesterdayPrice,
              currentPrice,
              buyPriceYesterdayDiff: `${buyPriceYesterdayDiff}%`,
              buyPriceDiff: `${buyPriceDiff}%`,
              note: item.note,
              tradingDate: data.tradingDate
            });
          } else {
            enrichedItems.push({
              _id: item._id,
              symbol: item.symbol,
              buyPrice: Number((item.buyPrice || 0).toFixed(2)),
              yesterdayPrice: 0,
              currentPrice: 0,
              buyPriceYesterdayDiff: '0%',
              buyPriceDiff: '0%',
              note: item.note,
              tradingDate: null
            });
          }
        } catch (_error) {
          enrichedItems.push({
            _id: item._id,
            symbol: item.symbol,
            buyPrice: Number((item.buyPrice || 0).toFixed(2)),
            yesterdayPrice: 0,
            currentPrice: 0,
            buyPriceYesterdayDiff: '0%',
            buyPriceDiff: '0%',
            note: item.note,
            tradingDate: null
          });
        }
      }

      io.to(userId.toString()).emit('watchlistUpdate', {
        success: true,
        total: enrichedItems.length,
        data: enrichedItems
      });
    }
    console.log('Cập nhật watchlist hoàn tất:', new Date().toLocaleString());
  } catch (err) {
    console.error('Lỗi khi cập nhật watchlist:', err.message);
  }
}

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', (userId) => {
    socket.join(userId.toString());
    console.log(`Client ${socket.id} joined room ${userId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Lên lịch cập nhật watchlist mỗi 5 phút
cron.schedule('*/5 * * * *', () => {
  console.log('Bắt đầu cập nhật watchlist...');
  updateWatchlist();
});

// =============================
// 8) CONTROLLERS: WATCHLIST (dùng updateWatchlist ở trên)
// =============================
const watchlistController = {
  // Thêm mã cổ phiếu vào watchlist
 addStock: async (req, res) => {
  try {
    const { symbol, buyPrice, note } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng nhập mã cổ phiếu'
      });
    }

    const existed = await Watchlist.findOne({
      userId: req.user.id,
      symbol: symbol.toUpperCase()
    });

    if (existed) {
      return res.status(400).json({
        success: false,
        message: 'Mã cổ phiếu này đã có trong danh sách theo dõi'
      });
    }

    const newItem = await Watchlist.create({
      userId: req.user.id,
      symbol: symbol.toUpperCase(),
      buyPrice: Number(buyPrice || 0),
      note
    });

    await updateWatchlist();

    res.json({
      success: true,
      message: 'Thêm thành công',
      data: {
        ...newItem._doc,
        buyPrice: Number((newItem.buyPrice || 0).toFixed(2))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
},


  // Lấy danh sách watchlist theo user với thông tin giá
  getWatchlist: async (req, res) => {
    try {
      const items = await Watchlist.find({ userId: req.user.id });
      const enrichedItems = [];

      for (const item of items) {
        try {
          const data = await fetchPrice(item.symbol);

          if (data) {
            const yesterdayPrice = Number((data.basicPrice || 0).toFixed(2));
            const currentPrice = Number((data.matchPrice || 0).toFixed(2));
            const buyPrice = Number((item.buyPrice || 0).toFixed(2));

            const buyPriceYesterdayDiff = yesterdayPrice !== 0
              ? (((currentPrice - yesterdayPrice) / yesterdayPrice) * 100).toFixed(2)
              : 0;
            const buyPriceDiff = buyPrice !== 0
              ? (((currentPrice - buyPrice) / buyPrice) * 100).toFixed(2)
              : 0;

            enrichedItems.push({
              _id: item._id,
              symbol: item.symbol,
              buyPrice,
              yesterdayPrice,
              currentPrice,
              buyPriceYesterdayDiff: `${buyPriceYesterdayDiff}%`,
              buyPriceDiff: `${buyPriceDiff}%`,
              note: item.note,
              tradingDate: data.tradingDate
            });
          } else {
            enrichedItems.push({
              _id: item._id,
              symbol: item.symbol,
              buyPrice: Number((item.buyPrice || 0).toFixed(2)),
              yesterdayPrice: 0,
              currentPrice: 0,
              buyPriceYesterdayDiff: '0%',
              buyPriceDiff: '0%',
              note: item.note,
              tradingDate: null
            });
          }
        } catch (_error) {
          enrichedItems.push({
            _id: item._id,
            symbol: item.symbol,
            buyPrice: Number((item.buyPrice || 0).toFixed(2)),
            yesterdayPrice: 0,
            currentPrice: 0,
            buyPriceYesterdayDiff: '0%',
            buyPriceDiff: '0%',
            note: item.note,
            tradingDate: null
          });
        }
      }

      res.json({ success: true, total: enrichedItems.length, data: enrichedItems });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  // Sửa thông tin cổ phiếu trong watchlist
  updateStock: async (req, res) => {
    try {
      const { id } = req.params;
      const { symbol, buyPrice, note } = req.body;

      const item = await Watchlist.findOneAndUpdate(
        { _id: id, userId: req.user.id },
        { symbol: symbol.toUpperCase(), buyPrice: Number(buyPrice || 0), note },
        { new: true }
      );

      if (!item) return res.status(404).json({ success: false, message: 'Không tìm thấy mục theo dõi' });

      await updateWatchlist();

      res.json({
        success: true,
        message: 'Cập nhật thành công',
        data: {
          ...item._doc,
          buyPrice: Number((item.buyPrice || 0).toFixed(2))
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  // Xóa cổ phiếu khỏi watchlist
  deleteStock: async (req, res) => {
    try {
      const { id } = req.params;

      const deleted = await Watchlist.findOneAndDelete({ _id: id, userId: req.user.id });
      if (!deleted) return res.status(404).json({ success: false, message: 'Không tìm thấy mục theo dõi' });

      await updateWatchlist();

      res.json({ success: true, message: 'Xóa thành công' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
};

// =============================
// 9) ROUTES
// =============================

// Auth routes
const authRouter = express.Router();
authRouter.post('/register', authController.register);
authRouter.post('/login', authController.login);
authRouter.get('/profile', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Stock routes
const stocksRouter = express.Router();
stocksRouter.get('/', stocksController.getStocksData);
stocksRouter.get('/trades/:symbol', stocksController.getStockTrades);
stocksRouter.get('/search', stocksController.searchStock);
stocksRouter.get('/history/:symbol', stocksController.getStockHistory);
stocksRouter.get('/top-gainers', stocksController.getTopGainers);
stocksRouter.get('/top-losers', stocksController.getTopLosers);

// Watchlist routes
const watchlistRouter = express.Router();
watchlistRouter.post('/', authMiddleware, watchlistController.addStock);
watchlistRouter.get('/', authMiddleware, watchlistController.getWatchlist);
watchlistRouter.put('/:id', authMiddleware, watchlistController.updateStock);
watchlistRouter.delete('/:id', authMiddleware, watchlistController.deleteStock);

// Mount routers
app.use('/api/auth', authRouter);
app.use('/api/stocks', stocksRouter);
app.use('/api/watchlist', watchlistRouter);
app.use(express.static('public'));

// Health check
app.get('/', (_req, res) => {
  res.json({ message: 'API is running 🚀' });
});

// =============================
// 10) START SERVER
// =============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
