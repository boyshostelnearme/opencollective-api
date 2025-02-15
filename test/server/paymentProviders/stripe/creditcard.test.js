/* eslint-disable camelcase */
import querystring from 'querystring';

import { expect } from 'chai';
import nock from 'nock';

import FEATURE from '../../../../server/constants/feature';
import OrderStatuses from '../../../../server/constants/order_status';
import cache from '../../../../server/lib/cache';
import models, { sequelize } from '../../../../server/models';
import creditcard from '../../../../server/paymentProviders/stripe/creditcard';
import stripeMocks from '../../../mocks/stripe';
import {
  fakeCollective,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeTransaction,
  fakeUser,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

async function createOrderWithPaymentMethod(paymentMethodName, orderParams = {}) {
  const user = await models.User.createUserWithCollective({
    name: 'TestMcTesterson',
    email: 'tmct@mct.com',
  });
  const host = await models.Collective.create({ name: 'Host Collective' });
  const tier = await models.Tier.create({ name: 'backer', amount: 0 });
  const collective = await models.Collective.create({ name: 'Parcel' });
  await collective.addHost(host, user, { shouldAutomaticallyApprove: true });
  const connectedAccount = await models.ConnectedAccount.create({
    service: 'stripe',
    token: 'tok_1Be9noDjPFcHOcTmT574CrEv',
    CollectiveId: host.id,
  });
  const paymentMethod = await models.PaymentMethod.create({
    name: paymentMethodName,
    token: 'tok_123456781234567812345678',
    service: 'stripe',
    type: 'creditcard',
    data: { expMonth: 11, expYear: 2025 },
    monthlyLimitPerMember: 10000,
    CollectiveId: collective.id,
  });
  const order = await models.Order.create(
    Object.assign(
      {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        PaymentMethodId: paymentMethod.id,
        TierId: tier.id,
        totalAmount: 1000,
        currency: 'USD',
      },
      orderParams,
    ),
  );
  order.fromCollective = user.collective;
  order.collective = collective;
  order.createdByUser = user;
  order.paymentMethod = paymentMethod;
  return { order, user, collective, paymentMethod, connectedAccount, host };
}

describe('server/paymentProviders/stripe/creditcard', () => {
  describe('#processOrder()', async () => {
    let secondCallToCreateCustomer, createIntentRequest;

    const setupNock = ({ balanceTransactions = { amount: 1000, currency: 'usd', fee: 0, fee_details: [] } } = {}) => {
      // Call performed by getOrCreateCustomerOnPlatformAccount
      nock('https://api.stripe.com:443').post('/v1/customers').reply(200, {});

      // Calls performed by getOrCreateCustomerIdForHost
      nock('https://api.stripe.com:443').post('/v1/tokens').reply(200, {});
      secondCallToCreateCustomer = nock('https://api.stripe.com:443').post('/v1/customers').reply(200, {});

      // Calls performed by createChargeAndTransactions
      nock('https://api.stripe.com:443')
        .post('/v1/payment_intents')
        .reply(200, (_, body) => {
          createIntentRequest = querystring.parse(body);
          return {
            id: 'pi_1F82vtBYycQg1OMfS2Rctiau',
            status: 'requires_confirmation',
          };
        });
      nock('https://api.stripe.com:443')
        .post('/v1/payment_intents/pi_1F82vtBYycQg1OMfS2Rctiau/confirm')
        .reply(200, {
          charges: {
            data: [{ id: 'ch_1B5j91D8MNtzsDcgNMsUgI8L', balance_transaction: 'txn_1B5j92D8MNtzsDcgQzIcmfrn' }],
          },
          status: 'succeeded',
        });
      nock('https://api.stripe.com:443')
        .get('/v1/balance_transactions/txn_1B5j92D8MNtzsDcgQzIcmfrn')
        .reply(200, balanceTransactions);
    };

    beforeEach(() => utils.resetTestDB());

    beforeEach(setupNock);

    beforeEach(async () => {
      const user = await fakeUser({ id: 30 }, { id: 20, slug: 'pia' });
      await fakeHost({ id: 8686, slug: 'opencollectiveinc', CreatedByUserId: user.id });
      // Move Collectives ID auto increment pointer up, so we don't collide with the manually created id:1
      await sequelize.query(`ALTER SEQUENCE "Collectives_id_seq" RESTART WITH 1453`);
    });

    afterEach(() => nock.cleanAll());

    it('should create a new customer id for a host', async () => {
      const { order } = await createOrderWithPaymentMethod('name');
      await creditcard.processOrder(order);
      expect(secondCallToCreateCustomer.isDone()).to.be.true;
    });

    it('has tax information stored in transaction', async () => {
      const taxAmount = 100;
      const { order } = await createOrderWithPaymentMethod('name', { taxAmount });
      const transaction = await creditcard.processOrder(order);
      expect(transaction.taxAmount).to.be.equal(-taxAmount);
    });

    describe('platform tips and host revenue share', () => {
      it('should collect the platform fee as application fee', async () => {
        nock.cleanAll();
        setupNock({
          balanceTransactions: {
            amount: 1100,
            currency: 'usd',
            fee: 0,
            fee_details: [
              {
                type: 'application_fee',
                amount: 100,
                currency: 'usd',
                application: 'ca_',
                description: 'OpenCollective application fee',
              },
            ],
          },
        });
        const { order } = await createOrderWithPaymentMethod('name', {
          totalAmount: 1100,
          platformTipAmount: 100,
        });

        await creditcard.processOrder(order);

        expect(createIntentRequest).to.have.property('amount', '1100');
        expect(createIntentRequest).to.have.property('application_fee_amount', '100');
      });

      it('should collect the host revenue share', async () => {
        const { order, host, collective } = await createOrderWithPaymentMethod('name', {
          totalAmount: 1000,
        });
        await collective.update({ hostFeePercent: 10 });
        await host.update({ plan: 'grow-plan-2021' });
        await cache.clear();

        await creditcard.processOrder(order);

        expect(createIntentRequest).to.have.property('amount', '1000');
        expect(createIntentRequest).to.have.property('application_fee_amount', `${1000 * 0.1 * 0.15}`);
      });

      it('should process orders correctly with zero decimal currencies', async () => {
        const { order } = await createOrderWithPaymentMethod('name', {
          totalAmount: 25000,
          currency: 'jpy',
          platformTipAmount: 5000,
        });

        await creditcard.processOrder(order);

        expect(createIntentRequest).to.have.property('amount', '250');
        expect(createIntentRequest).to.have.property('application_fee_amount', `50`);
      });

      it('should work with custom creditCardHostFeeSharePercent', async () => {
        const { order, host, collective } = await createOrderWithPaymentMethod('name', {
          totalAmount: 1000,
        });
        await collective.update({ hostFeePercent: 10 });
        await host.update({ plan: 'grow-plan-2021', data: { plan: { creditCardHostFeeSharePercent: 20 } } });
        await cache.clear();

        await creditcard.processOrder(order);

        expect(createIntentRequest).to.have.property('amount', '1000');
        expect(createIntentRequest).to.have.property('application_fee_amount', `${1000 * 0.1 * 0.2}`);
      });

      it('should work with creditCardHostFeeSharePercent = 0', async () => {
        const { order, host, collective } = await createOrderWithPaymentMethod('name', {
          totalAmount: 1000,
        });
        await collective.update({ hostFeePercent: 10, platformFeePercent: 0 });
        await host.update({ plan: 'grow-plan-2021', data: { plan: { creditCardHostFeeSharePercent: 0 } } });
        await cache.clear();

        await creditcard.processOrder(order);

        expect(createIntentRequest).to.have.property('amount', '1000');
        expect(createIntentRequest).to.not.have.property('application_fee_amount');
      });

      it('should collect both', async () => {
        nock.cleanAll();
        setupNock({
          balanceTransactions: {
            amount: 1100,
            currency: 'usd',
            fee: 0,
            fee_details: [
              {
                type: 'application_fee',
                amount: 115,
                currency: 'usd',
                application: 'ca_',
                description: 'OpenCollective application fee',
              },
            ],
          },
        });
        const { order, host, collective } = await createOrderWithPaymentMethod('name', {
          totalAmount: 1100,
          platformTipAmount: 100,
        });
        await collective.update({ hostFeePercent: 10 });
        await host.update({ plan: 'grow-plan-2021' });
        await cache.clear();

        await creditcard.processOrder(order);

        expect(createIntentRequest).to.have.property('amount', '1100');
        expect(createIntentRequest).to.have.property('application_fee_amount', `${1000 * 0.1 * 0.15 + 100}`);
      });

      it('should create a debt for platform tip and share if currency does not support application_fee', async () => {
        nock.cleanAll();
        setupNock({
          balanceTransactions: {
            amount: 1100,
            currency: 'BRL',
            fee_details: [],
          },
        });
        const { order, host, collective } = await createOrderWithPaymentMethod('name', {
          totalAmount: 1100,
          platformTipAmount: 100,
          currency: 'BRL',
        });
        await collective.update({ hostFeePercent: 10 });
        await host.update({ currency: 'BRL', plan: 'grow-plan-2021' });
        await cache.clear();

        await creditcard.processOrder(order);

        expect(createIntentRequest).to.have.property('amount', '1100');
        expect(createIntentRequest).to.not.have.property('application_fee_amount');

        const transactions = await order.getTransactions();
        expect(transactions.filter(t => t.kind === 'HOST_FEE_SHARE_DEBT')).to.have.lengthOf(2);
        expect(transactions.filter(t => t.kind === 'PLATFORM_TIP_DEBT')).to.have.lengthOf(2);
      });
    });
  });

  describe('#createDispute()', () => {
    let order, user;

    beforeEach(() => utils.resetTestDB());

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({ service: 'stripe', type: 'creditcard' });
      user = await fakeUser();
      order = await fakeOrder(
        {
          CreatedByUserId: user.id,
          totalAmount: 10,
          PaymentMethodId: paymentMethod.id,
        },
        { withSubscription: true },
      );
      const tx = await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          amount: 10,
          data: { charge: { id: stripeMocks.webhook_dispute_created.data.object.charge } },
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          TransactionGroup: tx.TransactionGroup,
          amount: 5,
        },
        { createDoubleEntry: true },
      );

      await creditcard.createDispute(stripeMocks.webhook_dispute_created);
    });

    it('limits Orders for User account', async () => {
      await user.reload();
      expect(user.data.features[FEATURE.ORDER]).to.eq(false);
    });

    it('disputes all Transactions connected to the charge', async () => {
      const transactions = await order.getTransactions();
      expect(transactions.map(tx => tx.isDisputed)).to.eql([true, true, true, true]);
    });

    it('disputes the Order connected to the charge', async () => {
      await order.reload();
      expect(order.status).to.eql(OrderStatuses.DISPUTED);
    });

    it('deactivates the Subscription connected to the charge', async () => {
      const subscription = await order.getSubscription();
      expect(subscription.isActive).to.eql(false);
    });
  });

  describe('#closeDispute()', () => {
    let order, user, paymentMethod;

    beforeEach(() => utils.resetTestDB());

    beforeEach(async () => {
      const collective = await fakeCollective({ isHostAccount: true });
      paymentMethod = await fakePaymentMethod({ service: 'stripe', type: 'creditcard' });
      user = await fakeUser();
      order = await fakeOrder(
        {
          CreatedByUserId: user.id,
          totalAmount: 10,
          PaymentMethodId: paymentMethod.id,
        },
        { withSubscription: true },
      );
      const tx = await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          HostCollectiveId: collective.id,
          amount: 10,
          data: { charge: { id: stripeMocks.webhook_dispute_created.data.object.charge } },
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          TransactionGroup: tx.TransactionGroup,
          amount: 5,
        },
        { createDoubleEntry: true },
      );
    });

    describe('the dispute was won and is not fraud', () => {
      it('un-disputes all Transactions connected to the charge', async () => {
        await creditcard.createDispute(stripeMocks.webhook_dispute_created);
        await creditcard.closeDispute(stripeMocks.webhook_dispute_won);

        const transactions = await order.getTransactions();
        expect(transactions.map(tx => tx.isDisputed)).to.eql([false, false, false, false]);
      });

      describe('when the Order has a Subscription', () => {
        it('resets the Order connected to the charge to ACTIVE', async () => {
          await creditcard.createDispute(stripeMocks.webhook_dispute_created);
          await creditcard.closeDispute(stripeMocks.webhook_dispute_won);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.ACTIVE);
        });

        it('reactivates the Subscription', async () => {
          await creditcard.createDispute(stripeMocks.webhook_dispute_created);
          await creditcard.closeDispute(stripeMocks.webhook_dispute_won);

          const subscription = await order.getSubscription();
          expect(subscription.isActive).to.eql(true);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('resets the Order connected to the charge to PAID', async () => {
          await order.update({ SubscriptionId: null });
          await creditcard.createDispute(stripeMocks.webhook_dispute_created);
          await creditcard.closeDispute(stripeMocks.webhook_dispute_won);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.PAID);
        });
      });

      describe('when the User has other disputed Orders', () => {
        it('does not remove the Order limit from the User', async () => {
          await fakeOrder(
            {
              CreatedByUserId: user.id,
              totalAmount: 20,
              PaymentMethodId: paymentMethod.id,
              status: OrderStatuses.DISPUTED,
            },
            { withSubscription: true },
          );
          await creditcard.createDispute(stripeMocks.webhook_dispute_created);
          await creditcard.closeDispute(stripeMocks.webhook_dispute_won);

          await user.reload();
          expect(user.data.features[FEATURE.ORDER]).to.eq(false);
        });
      });

      describe('when the User does not have other disputed Orders', () => {
        it('removes the Order limit from the User', async () => {
          await creditcard.createDispute(stripeMocks.webhook_dispute_created);
          await creditcard.closeDispute(stripeMocks.webhook_dispute_won);

          await user.reload();
          expect(user.data.features[FEATURE.ORDER]).to.eq(true);
        });
      });
    });

    describe('the dispute was lost and is fraud', () => {
      it('creates a refund transaction for the fraudulent transaction', async () => {
        await creditcard.createDispute(stripeMocks.webhook_dispute_created);
        await creditcard.closeDispute(stripeMocks.webhook_dispute_lost);

        const transactions = await order.getTransactions();
        const refundTransactions = transactions.filter(tx => tx.isRefund === true);
        expect(refundTransactions.length).to.eql(2);
      });

      it('creates a dispute fee DEBIT transaction for the host collective', async () => {
        await creditcard.createDispute(stripeMocks.webhook_dispute_created);
        await creditcard.closeDispute(stripeMocks.webhook_dispute_lost);

        const transactions = await order.getTransactions();
        const disputeFeeTransaction = transactions.find(tx => tx.description === 'Stripe Transaction Dispute Fee');
        expect(disputeFeeTransaction.amount).to.eql(-1500);
      });

      describe('when the Order has a Subscription', () => {
        it('resets the Order connected to the charge to CANCELLED', async () => {
          await creditcard.createDispute(stripeMocks.webhook_dispute_created);
          await creditcard.closeDispute(stripeMocks.webhook_dispute_lost);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.CANCELLED);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('resets the Order connected to the charge to REFUNDED', async () => {
          await order.update({ SubscriptionId: null });
          await creditcard.createDispute(stripeMocks.webhook_dispute_created);
          await creditcard.closeDispute(stripeMocks.webhook_dispute_lost);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.REFUNDED);
        });
      });
    });
  });

  describe('#openReview()', () => {
    let order, user;

    beforeEach(() => utils.resetTestDB());

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({ service: 'stripe', type: 'creditcard' });
      user = await fakeUser();
      order = await fakeOrder(
        {
          CreatedByUserId: user.id,
          totalAmount: 10,
          PaymentMethodId: paymentMethod.id,
        },
        { withSubscription: true },
      );
      const tx = await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          amount: 10,
          data: { charge: { payment_intent: stripeMocks.webhook_review_opened.data.object.payment_intent } },
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          TransactionGroup: tx.TransactionGroup,
          amount: 5,
        },
        { createDoubleEntry: true },
      );

      await creditcard.openReview(stripeMocks.webhook_review_opened);
    });

    it('updates isInReview status of all Transactions connected to the charge', async () => {
      const transactions = await order.getTransactions();
      expect(transactions.map(tx => tx.isInReview)).to.eql([true, true, true, true]);
    });

    it('changes status to IN_REVIEW of the Order connected to the charge', async () => {
      await order.reload();
      expect(order.status).to.eql(OrderStatuses.IN_REVIEW);
    });

    it('deactivates the Subscription connected to the charge', async () => {
      const subscription = await order.getSubscription();
      expect(subscription.isActive).to.eql(false);
    });
  });

  describe('#closeReview()', () => {
    let order, user;

    beforeEach(() => utils.resetTestDB());

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({ service: 'stripe', type: 'creditcard' });
      user = await fakeUser();
      order = await fakeOrder(
        {
          CreatedByUserId: user.id,
          totalAmount: 10,
          PaymentMethodId: paymentMethod.id,
        },
        { withSubscription: true },
      );
      const tx = await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          amount: 10,
          data: { charge: { payment_intent: stripeMocks.webhook_review_opened.data.object.payment_intent } },
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          TransactionGroup: tx.TransactionGroup,
          amount: 5,
        },
        { createDoubleEntry: true },
      );
    });

    describe('when review is "approved"', () => {
      it('updates isInReview status of all Transactions connected to the charge', async () => {
        await creditcard.openReview(stripeMocks.webhook_review_opened);
        await creditcard.closeReview(stripeMocks.webhook_review_closed_approved);

        const transactions = await order.getTransactions();
        expect(transactions.map(tx => tx.isInReview)).to.eql([false, false, false, false]);
      });

      describe('when the Order has a Subscription', () => {
        it('reactivates the Subscription connected to the charge', async () => {
          await creditcard.openReview(stripeMocks.webhook_review_opened);
          await creditcard.closeReview(stripeMocks.webhook_review_closed_approved);

          const subscription = await order.getSubscription();
          expect(subscription.isActive).to.eql(true);
        });

        it('changes Order status back to ACTIVE', async () => {
          await creditcard.openReview(stripeMocks.webhook_review_opened);
          await creditcard.closeReview(stripeMocks.webhook_review_closed_approved);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.ACTIVE);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('changes Order status back to PAID', async () => {
          await order.update({ SubscriptionId: null });
          await creditcard.openReview(stripeMocks.webhook_review_opened);
          await creditcard.closeReview(stripeMocks.webhook_review_closed_approved);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.PAID);
        });
      });
    });

    describe('when review is "refunded_as_fraud"', () => {
      describe('when the Order has a Subscription', () => {
        it('changes Order status to CANCELLED', async () => {
          await creditcard.openReview(stripeMocks.webhook_review_opened);
          await creditcard.closeReview(stripeMocks.webhook_review_closed_refunded_as_fraud);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.CANCELLED);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('changes Order status back to REFUNDED', async () => {
          await order.update({ SubscriptionId: null });
          await creditcard.openReview(stripeMocks.webhook_review_opened);
          await creditcard.closeReview(stripeMocks.webhook_review_closed_refunded_as_fraud);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.REFUNDED);
        });
      });

      it('limits Orders for User account', async () => {
        await creditcard.openReview(stripeMocks.webhook_review_opened);
        await creditcard.closeReview(stripeMocks.webhook_review_closed_refunded_as_fraud);

        await user.reload();
        expect(user.data.features[FEATURE.ORDER]).to.eq(false);
      });

      it('creates a refund transaction for the fraudulent transaction', async () => {
        await creditcard.openReview(stripeMocks.webhook_review_opened);
        await creditcard.closeReview(stripeMocks.webhook_review_closed_refunded_as_fraud);

        const transactions = await order.getTransactions();
        const refundTransactions = transactions.filter(tx => tx.isRefund === true);
        expect(refundTransactions.length).to.eql(2);
      });
    });

    describe('when review is "refunded"', () => {
      describe('when the Order has a Subscription', () => {
        it('changes Order status to CANCELLED', async () => {
          await creditcard.openReview(stripeMocks.webhook_review_opened);
          await creditcard.closeReview(stripeMocks.webhook_review_closed_refunded);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.CANCELLED);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('changes Order status back to REFUNDED', async () => {
          await order.update({ SubscriptionId: null });
          await creditcard.openReview(stripeMocks.webhook_review_opened);
          await creditcard.closeReview(stripeMocks.webhook_review_closed_refunded);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.REFUNDED);
        });
      });

      it('does not limit Orders for User account', async () => {
        await creditcard.openReview(stripeMocks.webhook_review_opened);
        await creditcard.closeReview(stripeMocks.webhook_review_closed_refunded);

        await user.reload();
        expect(user.data).to.eq(null);
      });

      it('creates a refund transaction for the fraudulent transaction', async () => {
        await creditcard.openReview(stripeMocks.webhook_review_opened);
        await creditcard.closeReview(stripeMocks.webhook_review_closed_refunded);

        const transactions = await order.getTransactions();
        const refundTransactions = transactions.filter(tx => tx.isRefund === true);
        expect(refundTransactions.length).to.eql(2);
      });

      it('updates all related transactions to remove in review status', async () => {
        await creditcard.openReview(stripeMocks.webhook_review_opened);
        await creditcard.closeReview(stripeMocks.webhook_review_closed_refunded);

        const transactions = await order.getTransactions();
        expect(transactions.every(tx => tx.isInReview === false)).to.eql(true);
      });
    });
  });
});
