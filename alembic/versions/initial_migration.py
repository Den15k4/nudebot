"""initial migration

Revision ID: 1a2b3c4d5e6f
Revises: 
Create Date: 2024-01-01 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '1a2b3c4d5e6f'
down_revision = None
branch_labels = None
depends_on = None

def upgrade() -> None:
    # Users table
    op.create_table(
        'users',
        sa.Column('user_id', sa.BigInteger(), nullable=False),
        sa.Column('username', sa.String(length=100), nullable=True),
        sa.Column('registered_at', sa.DateTime(), server_default=sa.text('now()'), nullable=True),
        sa.Column('last_activity', sa.DateTime(), server_default=sa.text('now()'), nullable=True),
        sa.Column('settings', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint('user_id')
    )

    # Subscriptions table
    op.create_table(
        'subscriptions',
        sa.Column('user_id', sa.BigInteger(), nullable=False),
        sa.Column('images_left', sa.Integer(), nullable=True),
        sa.Column('subscription_end', sa.DateTime(), nullable=True),
        sa.PrimaryKeyConstraint('user_id')
    )

    # Generations table
    op.create_table(
        'generations',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.BigInteger(), nullable=False),
        sa.Column('style', sa.String(length=100), nullable=False),
        sa.Column('params', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=True),
        sa.Column('completed_at', sa.DateTime(), nullable=True),
        sa.Column('image_data', sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )

    # Statistics table
    op.create_table(
        'statistics',
        sa.Column('user_id', sa.BigInteger(), nullable=False),
        sa.Column('total_generations', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('successful_generations', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('style_statistics', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.PrimaryKeyConstraint('user_id')
    )

def downgrade() -> None:
    op.drop_table('statistics')
    op.drop_table('generations')
    op.drop_table('subscriptions')
    op.drop_table('users')
