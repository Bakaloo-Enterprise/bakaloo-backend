import { AdminAnalyticsRepository } from './analytics.repository.js'
import PDFDocument from 'pdfkit'
import ExcelJS from 'exceljs'

const repo = new AdminAnalyticsRepository()

export class AdminAnalyticsService {
  async getSalesAnalytics(params) {
    return repo.getSalesAnalytics(params)
  }

  async getProductPerformance(params) {
    return repo.getProductPerformance(params)
  }

  async getCustomerCohorts(params) {
    return repo.getCustomerCohorts(params)
  }

  async getDeliveryAnalytics(params) {
    return repo.getDeliveryAnalytics(params)
  }

  async getFinancialReport(params) {
    return repo.getFinancialReport(params)
  }

  async getCartEnhancementAnalytics(params) {
    return repo.getCartEnhancementAnalytics(params)
  }

  async getComparison(params) {
    return repo.getComparisonStats(
      params.period1Start, params.period1End,
      params.period2Start, params.period2End,
      params.shopId
    )
  }

  async getGeographicAnalytics(params) {
    return repo.getGeographicAnalytics(params)
  }

  async getDeadStock(params) {
    return repo.getDeadStockProducts(params)
  }

  async exportReportExcel({ startDate, endDate, shopId }) {
    const [sales, financial] = await Promise.all([
      repo.getSalesAnalytics({ startDate, endDate, shopId }),
      repo.getFinancialReport({ startDate, endDate, shopId }),
    ])

    const workbook = new ExcelJS.Workbook()

    const summarySheet = workbook.addWorksheet('Summary')
    summarySheet.columns = [
      { header: 'Metric', key: 'metric', width: 28 },
      { header: 'Value', key: 'value', width: 20 },
    ]
    summarySheet.addRows([
      { metric: 'Sold (before refunds)', value: sales.summary.gross_sales },
      { metric: 'Refunds', value: sales.summary.total_refunds },
      { metric: 'Money kept (sold − refunds)', value: sales.summary.total_revenue },
      { metric: 'Orders that stood', value: sales.summary.total_orders },
      { metric: 'Average Order Value', value: sales.summary.avg_order_value },
      { metric: 'Unique Customers', value: sales.summary.unique_customers },
      { metric: 'Total Discounts', value: sales.summary.total_discounts },
      { metric: 'Billed to customers (gross)', value: financial.revenue.gross },
      { metric: 'Net after refunds', value: financial.revenue.net },
      { metric: 'Delivery Fees', value: financial.revenue.delivery_fees },
    ])

    const dailySheet = workbook.addWorksheet('Daily Sales')
    dailySheet.columns = [
      { header: 'Date', key: 'period', width: 14 },
      { header: 'Money kept (₹)', key: 'revenue', width: 16 },
      { header: 'Sold (₹)', key: 'gross_sales', width: 14 },
      { header: 'Refunds (₹)', key: 'refunds', width: 14 },
      { header: 'Orders', key: 'orders', width: 12 },
      { header: 'Avg Order Value (₹)', key: 'avg_order_value', width: 18 },
      { header: 'Discount (₹)', key: 'total_discount', width: 14 },
    ]
    dailySheet.addRows(sales.timeSeries)

    const paymentSheet = workbook.addWorksheet('Payment Methods')
    paymentSheet.columns = [
      { header: 'Method', key: 'payment_method', width: 20 },
      { header: 'Revenue (₹)', key: 'revenue', width: 16 },
      { header: 'Orders', key: 'count', width: 12 },
    ]
    paymentSheet.addRows(financial.byPaymentMethod)

    if (financial.gstBreakdown.length > 0) {
      const gstSheet = workbook.addWorksheet('GST Breakdown')
      gstSheet.columns = [
        { header: 'GST Rate (%)', key: 'gst_rate', width: 14 },
        { header: 'Taxable Amount (₹)', key: 'taxable_amount', width: 18 },
        { header: 'GST Amount (₹)', key: 'gst_amount', width: 16 },
      ]
      gstSheet.addRows(financial.gstBreakdown)
    }

    return workbook.xlsx.writeBuffer()
  }

  async exportReportPDF({ startDate, endDate, shopId }) {
    const [sales, financial] = await Promise.all([
      repo.getSalesAnalytics({ startDate, endDate, shopId }),
      repo.getFinancialReport({ startDate, endDate, shopId }),
    ])

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 })
      const chunks = []
      doc.on('data', c => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // Title
      doc.fontSize(20).text('Analytics Report', { align: 'center' })
      doc.moveDown()
      if (startDate || endDate) {
        doc.fontSize(10).text(`Period: ${startDate || 'start'} — ${endDate || 'now'}`, { align: 'center' })
        doc.moveDown()
      }

      // Sales Summary
      doc.fontSize(14).text('Sales Summary')
      doc.moveDown(0.5)
      doc.fontSize(10)
      const s = sales.summary
      doc.text(`Sold (before refunds): ₹${s.gross_sales.toLocaleString('en-IN')}`)
      doc.text(`Refunds: ₹${s.total_refunds.toLocaleString('en-IN')}`)
      doc.text(`Money kept: ₹${s.total_revenue.toLocaleString('en-IN')}`)
      doc.text(`Orders that stood: ${s.total_orders}`)
      doc.text(`Average Order Value: ₹${s.avg_order_value.toFixed(2)}`)
      doc.text(`Unique Customers: ${s.unique_customers}`)
      doc.text(`Total Discounts: ₹${s.total_discounts.toLocaleString('en-IN')}`)
      doc.moveDown()

      // Financial Summary
      doc.fontSize(14).text('Financial Summary')
      doc.moveDown(0.5)
      doc.fontSize(10)
      const f = financial.revenue
      doc.text(`Billed to customers: ₹${f.gross.toLocaleString('en-IN')}`)
      doc.text(`Refunds: ₹${f.refunds.toLocaleString('en-IN')}`)
      doc.text(`Net after refunds: ₹${f.net.toLocaleString('en-IN')}`)
      doc.text(`Delivery Fees: ₹${f.delivery_fees.toLocaleString('en-IN')}`)
      doc.moveDown()

      // Payment Methods
      doc.fontSize(14).text('Payment Methods')
      doc.moveDown(0.5)
      doc.fontSize(10)
      for (const pm of financial.byPaymentMethod) {
        doc.text(`${pm.payment_method}: ₹${pm.revenue.toLocaleString('en-IN')} (${pm.count} orders)`)
      }
      doc.moveDown()

      // GST Breakdown
      if (financial.gstBreakdown.length > 0) {
        doc.fontSize(14).text('GST Breakdown')
        doc.moveDown(0.5)
        doc.fontSize(10)
        for (const g of financial.gstBreakdown) {
          doc.text(`${g.gst_rate}%: Taxable ₹${g.taxable_amount.toLocaleString('en-IN')}, GST ₹${g.gst_amount.toLocaleString('en-IN')}`)
        }
      }

      doc.end()
    })
  }
}
